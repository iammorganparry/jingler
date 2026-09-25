import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdtemp } from "node:fs/promises"
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from "vscode-jsonrpc/node.js"
import type { Hover, MarkedString, MarkupContent } from "vscode-languageserver-protocol"
import { stopChild, trackChild } from "../../child-registry.js"
import { ToolError } from "./tool-registry.js"
import {
  codeHover,
  disposeTypeScriptAnalysis,
  shutdownTypeScriptAnalysis,
  type AnalysisResult
} from "./typescript-analysis.js"

export interface LanguageHoverValue {
  readonly type: string
  readonly documentation?: string
}

export type LanguageHoverResult =
  | AnalysisResult<LanguageHoverValue>
  | {
      readonly engine: "eclipse-jdtls"
      readonly value: LanguageHoverValue
      readonly timing: { readonly requestMs: number }
    }

interface JdtSession {
  readonly process: ChildProcessWithoutNullStreams
  readonly connection: MessageConnection
  readonly dataDir: string
  readonly versions: Map<string, { readonly contents: string; readonly version: number }>
}
interface JdtEntry {
  readonly promise: Promise<JdtSession>
  readonly controller: AbortController
}

const sessions = new Map<string, JdtEntry>()
const disposalEpochs = new Map<string, number>()
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u
const MAX_JDT_SESSIONS = 3
const MAX_JDT_OPEN_DOCUMENTS = 32
const JDT_REQUEST_TIMEOUT_MS = 10_000
const fail = (message: string): ToolError => new ToolError("execution-failed", message)
const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)
const JAVA_IDENTIFIER = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}]*$/u
const JAVA_IDENTIFIER_PART = /[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}]/u
const javaSymbolAt = (line: string, symbol: string, offset: number): boolean =>
  offset >= 0 &&
  line.slice(offset, offset + symbol.length) === symbol &&
  !JAVA_IDENTIFIER_PART.test(line[offset - 1] ?? "") &&
  !JAVA_IDENTIFIER_PART.test(line[offset + symbol.length] ?? "")

const markdownText = (contents: Hover["contents"]): string => {
  const part = (value: MarkedString | MarkupContent): string =>
    typeof value === "string"
      ? value
      : "language" in value
        ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
        : value.value
  return (Array.isArray(contents) ? contents : [contents]).map(part).join("\n\n").trim()
}

const startJdtSession = async (root: string, signal: AbortSignal): Promise<JdtSession> => {
  signal.throwIfAborted()
  const dataDir = await mkdtemp(join(tmpdir(), "jingler-jdtls-"))
  if (signal.aborted) {
    await rm(dataDir, { recursive: true, force: true })
    signal.throwIfAborted()
  }
  const child = trackChild(spawn("jdtls", ["-data", dataDir], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  }))
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000)
  })
  let rejectAbort: ((cause: unknown) => void) | undefined
  const abort = () => rejectAbort?.(signal.reason ?? fail("JDT.LS startup was cancelled"))
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
    if (signal.aborted) abort()
  })
  signal.addEventListener("abort", abort, { once: true })
  await Promise.race([
    new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn)
      child.once("error", (cause) => rejectSpawn(fail(`JDT.LS could not start: ${String(cause)}`)))
    }),
    aborted
  ]).catch(async (cause) => {
    signal.removeEventListener("abort", abort)
    stopChild(child)
    await rm(dataDir, { recursive: true, force: true })
    throw cause
  })
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin)
  )
  connection.listen()
  const exited = new Promise<never>((_, reject) => {
    child.once("error", (cause) => reject(fail(`JDT.LS could not start: ${String(cause)}`)))
    child.once("exit", (code) => reject(fail(`JDT.LS exited (${code ?? "signal"}): ${stderr.trim() || "no error output"}`)))
  })
  let initializationTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            synchronization: { didSave: false, dynamicRegistration: false }
          },
          workspace: { workspaceFolders: true }
        },
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: root.split(sep).at(-1) ?? root }]
      }),
      exited,
      aborted,
      new Promise<never>((_, reject) => {
        initializationTimer = setTimeout(
          () => reject(fail("JDT.LS initialization timed out after 30 seconds")),
          30_000
        )
      })
    ])
    connection.sendNotification("initialized", {})
  } catch (cause) {
    connection.dispose()
    stopChild(child)
    await rm(dataDir, { recursive: true, force: true })
    throw cause
  } finally {
    signal.removeEventListener("abort", abort)
    if (initializationTimer !== undefined) clearTimeout(initializationTimer)
  }
  const session = { process: child, connection, dataDir, versions: new Map() }
  child.once("exit", () => {
    connection.dispose()
    void rm(dataDir, { recursive: true, force: true })
  })
  return session
}

const closeJdtSession = async (entry: JdtEntry): Promise<void> => {
  entry.controller.abort(fail("JDT.LS session was disposed"))
  try {
    const session = await entry.promise
    session.connection.dispose()
    stopChild(session.process)
    await rm(session.dataDir, { recursive: true, force: true })
  } catch {
    // Failed startup already performed its own cleanup.
  }
}

const invalidateJdtSession = async (root: string, session: JdtSession): Promise<void> => {
  const entry = sessions.get(root)
  if (entry === undefined || await entry.promise.catch(() => undefined) !== session) return
  sessions.delete(root)
  await closeJdtSession(entry)
}

const jdtSession = async (root: string): Promise<JdtSession> => {
  const existing = sessions.get(root)
  if (existing !== undefined) {
    sessions.delete(root)
    sessions.set(root, existing)
    return existing.promise
  }

  const oldest = sessions.size >= MAX_JDT_SESSIONS
    ? sessions.entries().next().value as [string, JdtEntry] | undefined
    : undefined
  if (oldest !== undefined) sessions.delete(oldest[0])
  const controller = new AbortController()
  const promise = (async () => {
    if (oldest !== undefined) await closeJdtSession(oldest[1])
    controller.signal.throwIfAborted()
    return startJdtSession(root, controller.signal)
  })()
  const entry = { promise, controller }
  sessions.set(root, entry)
  void promise.then((session) => {
    session.process.once("exit", () => {
      if (sessions.get(root) === entry) sessions.delete(root)
    })
  }, () => {})
  try {
    return await promise
  } catch (cause) {
    if (sessions.get(root) === entry) sessions.delete(root)
    throw cause
  }
}

export const syncJavaDocument = (
  session: JdtSession,
  uri: string,
  contents: string
): void => {
  const previous = session.versions.get(uri)
  if (previous !== undefined) session.versions.delete(uri)
  if (previous?.contents === contents) {
    session.versions.set(uri, previous)
    return
  }
  if (previous === undefined && session.versions.size >= MAX_JDT_OPEN_DOCUMENTS) {
    const oldest = session.versions.keys().next().value as string
    session.versions.delete(oldest)
    session.connection.sendNotification("textDocument/didClose", { textDocument: { uri: oldest } })
  }
  const version = (previous?.version ?? 0) + 1
  session.versions.set(uri, { contents, version })
  if (previous === undefined) {
    session.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "java", version, text: contents }
    })
    return
  }
  session.connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text: contents }]
  })
}

const boundedRequest = async <Value>(
  send: (token: CancellationTokenSource["token"]) => Promise<Value>,
  signal?: AbortSignal
): Promise<Value> => {
  const cancellation = new CancellationTokenSource()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: ((cause: unknown) => void) | undefined
  const abort = () => {
    cancellation.cancel()
    rejectAbort?.(signal?.reason ?? fail("Language server request was cancelled"))
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([
      send(cancellation.token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancellation.cancel()
          reject(fail(`Language server request timed out after ${JDT_REQUEST_TIMEOUT_MS / 1_000} seconds`))
        }, JDT_REQUEST_TIMEOUT_MS)
      }),
      new Promise<never>((_, reject) => {
        rejectAbort = reject
        if (signal?.aborted) abort()
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    cancellation.dispose()
  }
}

const javaHover = async (
  root: string,
  absolute: string,
  line: number,
  column: number,
  contents: string,
  signal?: AbortSignal
): Promise<LanguageHoverResult | null> => {
  const started = performance.now()
  const session = await jdtSession(root)
  const uri = pathToFileURL(absolute).href
  syncJavaDocument(session, uri, contents)
  let hover: Hover | null
  try {
    hover = await boundedRequest(
      (token) => session.connection.sendRequest<Hover | null>("textDocument/hover", {
        textDocument: { uri },
        position: { line: line - 1, character: column - 1 }
      }, token),
      signal
    )
  } catch (cause) {
    if (!signal?.aborted) await invalidateJdtSession(root, session)
    throw cause
  }
  if (hover === null) return null
  const text = markdownText(hover.contents)
  if (text.length === 0) return null
  return {
    engine: "eclipse-jdtls",
    value: { type: text },
    timing: { requestMs: Math.round(performance.now() - started) }
  }
}

const javaLanguageHover = async (
  rootKey: string,
  root: string,
  absolute: string,
  symbol: string,
  line: number,
  column: number | undefined,
  contents: string | undefined,
  startEpoch: number,
  signal: AbortSignal | undefined
): Promise<LanguageHoverResult | null> => {
  if (!JAVA_IDENTIFIER.test(symbol)) throw fail(`Invalid Java identifier: ${symbol}`)
  const source = contents ?? await readFile(absolute, "utf8")
  if ((disposalEpochs.get(rootKey) ?? 0) !== startEpoch) {
    throw fail("Java analysis was disposed while hover setup was in progress")
  }
  const sourceLine = source.replaceAll("\r\n", "\n").split("\n")[line - 1] ?? ""
  if (column !== undefined) {
    if (!javaSymbolAt(sourceLine, symbol, column - 1)) throw fail(`Symbol not found at requested Java position: ${symbol}`)
    return javaHover(root, absolute, line, column, source, signal)
  }
  const matches: number[] = []
  for (let offset = sourceLine.indexOf(symbol); offset >= 0; offset = sourceLine.indexOf(symbol, offset + 1)) {
    if (javaSymbolAt(sourceLine, symbol, offset)) matches.push(offset)
  }
  if (matches.length !== 1) throw fail("Java hover needs a column when the symbol is missing or repeated on the line")
  return javaHover(root, absolute, line, matches[0]! + 1, source, signal)
}

export const languageHover = async (
  cwd: string,
  file: string,
  symbol: string,
  line: number,
  column?: number,
  contents?: string,
  signal?: AbortSignal
): Promise<LanguageHoverResult | null> => {
  signal?.throwIfAborted()
  if (symbol.length === 0) throw fail("Language hover needs a symbol")
  const rootKey = resolve(cwd)
  const startEpoch = disposalEpochs.get(rootKey) ?? 0
  const root = await realpath(rootKey)
  const requested = resolve(root, file)
  if (!contained(root, requested)) throw fail("Language intelligence path escapes the workspace")
  const absolute = await realpath(requested)
  if (!contained(root, absolute)) throw fail("Language intelligence path escapes the workspace")
  if (extname(absolute).toLowerCase() === ".java") {
    return javaLanguageHover(rootKey, root, absolute, symbol, line, column, contents, startEpoch, signal)
  }
  if (SOURCE_FILE.test(absolute)) {
    return codeHover(root, file, symbol, line, column, signal)
  }
  throw fail(`Language intelligence is unavailable for ${extname(absolute) || "this file"}`)
}

export const disposeLanguageIntelligence = async (cwd: string): Promise<void> => {
  const rootKey = resolve(cwd)
  disposalEpochs.set(rootKey, (disposalEpochs.get(rootKey) ?? 0) + 1)
  const root = await realpath(rootKey).catch(() => rootKey)
  const entry = sessions.get(root)
  if (entry !== undefined) {
    sessions.delete(root)
    await closeJdtSession(entry)
  }
  await disposeTypeScriptAnalysis(root)
}

export const shutdownLanguageIntelligence = async (): Promise<void> => {
  shutdownTypeScriptAnalysis()
  disposalEpochs.clear()
  const active = [...sessions.values()]
  sessions.clear()
  await Promise.allSettled(active.map(closeJdtSession))
}
