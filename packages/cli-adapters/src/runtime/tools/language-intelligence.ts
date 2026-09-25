import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdtemp } from "node:fs/promises"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from "vscode-jsonrpc/node.js"
import type { Hover, MarkedString, MarkupContent } from "vscode-languageserver-protocol"
import { stopChild, trackChild } from "../../child-registry.js"
import { ToolError } from "./tool-registry.js"
import { codeHover, type AnalysisResult } from "./typescript-analysis.js"

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

const sessions = new Map<string, Promise<JdtSession>>()
let sessionCreation = Promise.resolve()
const SOURCE_FILE = /\.[cm]?[jt]sx?$/u
const MAX_JDT_SESSIONS = 3
const JDT_REQUEST_TIMEOUT_MS = 10_000
const fail = (message: string): ToolError => new ToolError("execution-failed", message)
const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

const markdownText = (contents: Hover["contents"]): string => {
  const part = (value: MarkedString | MarkupContent): string =>
    typeof value === "string"
      ? value
      : "language" in value
        ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
        : value.value
  return (Array.isArray(contents) ? contents : [contents]).map(part).join("\n\n").trim()
}

const startJdtSession = async (root: string): Promise<JdtSession> => {
  const dataDir = await mkdtemp(join(tmpdir(), "jingler-jdtls-"))
  const child = trackChild(spawn("jdtls", ["-data", dataDir], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  }))
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000)
  })
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn)
    child.once("error", (cause) => rejectSpawn(fail(`JDT.LS could not start: ${String(cause)}`)))
  }).catch(async (cause) => {
    child.kill()
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
    if (initializationTimer !== undefined) clearTimeout(initializationTimer)
  }
  const session = { process: child, connection, dataDir, versions: new Map() }
  child.once("exit", () => {
    connection.dispose()
    void rm(dataDir, { recursive: true, force: true })
  })
  return session
}

const closeJdtSession = async (pending: Promise<JdtSession>): Promise<void> => {
  try {
    const session = await pending
    session.connection.dispose()
    stopChild(session.process)
    await rm(session.dataDir, { recursive: true, force: true })
  } catch {
    // Failed startup already performed its own cleanup.
  }
}

const jdtSession = async (root: string): Promise<JdtSession> => {
  const existing = sessions.get(root)
  if (existing !== undefined) {
    sessions.delete(root)
    sessions.set(root, existing)
    return existing
  }

  let release!: () => void
  const previousCreation = sessionCreation
  sessionCreation = new Promise<void>((resolveCreation) => {
    release = resolveCreation
  })
  await previousCreation
  try {
    const racedExisting = sessions.get(root)
    if (racedExisting !== undefined) return racedExisting
    if (sessions.size >= MAX_JDT_SESSIONS) {
      const oldest = sessions.entries().next().value as [string, Promise<JdtSession>] | undefined
      if (oldest !== undefined) {
        sessions.delete(oldest[0])
        await closeJdtSession(oldest[1])
      }
    }
    const created = startJdtSession(root)
    sessions.set(root, created)
    void created.then((session) => {
      session.process.once("exit", () => {
        if (sessions.get(root) === created) sessions.delete(root)
      })
    }, () => {})
    try {
      return await created
    } catch (cause) {
      if (sessions.get(root) === created) sessions.delete(root)
      throw cause
    }
  } finally {
    release()
  }
}

const syncJavaDocument = (
  session: JdtSession,
  uri: string,
  contents: string
): void => {
  const previous = session.versions.get(uri)
  if (previous?.contents === contents) return
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
  request: Promise<Value>,
  signal?: AbortSignal
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(fail(`Language server request timed out after ${JDT_REQUEST_TIMEOUT_MS / 1_000} seconds`)),
          JDT_REQUEST_TIMEOUT_MS
        )
      }),
      new Promise<never>((_, reject) => {
        if (signal === undefined) return
        abort = () => reject(signal.reason ?? fail("Language server request was cancelled"))
        signal.addEventListener("abort", abort, { once: true })
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal?.removeEventListener("abort", abort)
  }
}

const javaHover = async (
  root: string,
  absolute: string,
  line: number,
  column: number,
  contents: string,
  signal?: AbortSignal
): Promise<LanguageHoverResult> => {
  const started = performance.now()
  const session = await jdtSession(root)
  const uri = pathToFileURL(absolute).href
  syncJavaDocument(session, uri, contents)
  const hover = await boundedRequest(
    session.connection.sendRequest<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 }
    }),
    signal
  )
  if (hover === null) throw fail("JDT.LS returned no hover information")
  const text = markdownText(hover.contents)
  if (text.length === 0) throw fail("JDT.LS returned empty hover information")
  return {
    engine: "eclipse-jdtls",
    value: { type: text },
    timing: { requestMs: Math.round(performance.now() - started) }
  }
}

export const languageHover = async (
  cwd: string,
  file: string,
  symbol: string,
  line: number,
  column?: number,
  contents?: string,
  signal?: AbortSignal
): Promise<LanguageHoverResult> => {
  signal?.throwIfAborted()
  const root = await realpath(resolve(cwd))
  const requested = resolve(root, file)
  if (!contained(root, requested)) throw fail("Language intelligence path escapes the workspace")
  const absolute = await realpath(requested)
  if (!contained(root, absolute)) throw fail("Language intelligence path escapes the workspace")
  if (extname(absolute).toLowerCase() === ".java") {
    const source = contents ?? await readFile(absolute, "utf8")
    const sourceLine = source.replaceAll("\r\n", "\n").split("\n")[line - 1] ?? ""
    const first = sourceLine.indexOf(symbol)
    const last = sourceLine.lastIndexOf(symbol)
    const resolvedColumn = column ?? (first >= 0 && first === last ? first + 1 : undefined)
    if (resolvedColumn === undefined) throw fail("Java hover needs a column when the symbol is missing or repeated on the line")
    return javaHover(root, absolute, line, resolvedColumn, source, signal)
  }
  if (SOURCE_FILE.test(absolute)) {
    return codeHover(root, file, symbol, line, column, signal)
  }
  throw fail(`Language intelligence is unavailable for ${extname(absolute) || "this file"}`)
}

export const shutdownLanguageIntelligence = async (): Promise<void> => {
  const active = [...sessions.values()]
  sessions.clear()
  await Promise.allSettled(active.map(async (pending) => {
    const session = await pending
    await session.connection.sendRequest("shutdown")
    session.connection.sendNotification("exit")
    session.connection.dispose()
    stopChild(session.process)
    await rm(session.dataDir, { recursive: true, force: true })
  }))
}
