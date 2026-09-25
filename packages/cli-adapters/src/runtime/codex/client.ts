import { nativeCliEnvironment } from "../providers/native-cli-environment.js"
import { promisify } from "node:util"
import { stopChild, trackChild } from "../../child-registry.js"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { InitializeParams } from "./generated/InitializeParams.js"

/** Explicit system allowlist: native credentials come from Codex's own home. */
export const codexEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...nativeCliEnvironment(environment),
  ...Object.fromEntries(
    ["CODEX_HOME", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]]
    )
  )
})

export class UnsupportedCodexPlatformError extends Error {
  constructor() {
    super("Native Codex is unsupported on Windows until owned Job Object cleanup is available")
  }
}
const assertSupportedPlatform = () => {
  if (process.platform === "win32") throw new UnsupportedCodexPlatformError()
}

export const CODEX_PROTOCOL_VERSION = "0.153.2"
export const readCodexVersion = async (
  options: CodexClientOptions = {}
): Promise<string | null> => {
  assertSupportedPlatform()
  const { stdout } = await promisify(execFile)(
    options.binary ?? process.env.JINGLER_CODEX_BINARY ?? "codex",
    ["--version"],
    {
      env: codexEnvironment(options.environment ?? process.env),
      timeout: 5_000,
      maxBuffer: 64_000
    }
  )
  return /\b\d+\.\d+\.\d+\b/u.exec(stdout)?.[0] ?? null
}

export interface CodexClientOptions {
  readonly mcpEnvironmentKeys?: readonly string[]
  readonly binary?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly spawnProcess?: typeof spawn
  readonly timeoutMs?: number
  readonly maxFrameBytes?: number
}
export interface CodexMessage {
  readonly id?: string | number
  readonly method: string
  readonly params: Record<string, unknown>
}
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** One owned stdio process per run/probe. No global request or event bus. */
export class CodexClient {
  private readonly child: ChildProcessWithoutNullStreams
  private sequence = 0
  private buffer = ""
  private failure: Error | null = null
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly listeners = new Set<(message: CodexMessage) => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()
  private readonly closed: Promise<void>
  private closing: Promise<void> | undefined
  constructor(private readonly options: CodexClientOptions = {}) {
    assertSupportedPlatform()
    const environment = options.environment ?? process.env
    const env = codexEnvironment(environment)
    // Only explicit run-scoped attachments may extend the inherited allowlist.
    for (const name of options.mcpEnvironmentKeys ?? []) env[name] = environment[name]
    this.child = (options.spawnProcess ?? spawn)(
      options.binary ?? process.env.JINGLER_CODEX_BINARY ?? "codex",
      ["app-server"],
      {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      }
    )
    trackChild(this.child, true)
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        this.fail(new Error("Codex app-server closed"))
        resolve()
      })
    )
    this.child.on("error", () => this.fail(new Error("Could not launch Codex app-server")))
    this.child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed")))
    // Drain diagnostics without forwarding potentially secret-bearing vendor output.
    this.child.stderr.resume()
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
  }
  onMessage(listener: (message: CodexMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    if (this.failure) listener(this.failure)
    return () => this.failureListeners.delete(listener)
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    for (const listener of this.failureListeners) listener(error)
    void this.close()
  }
  private receive(chunk: string): void {
    if (this.failure) return
    this.buffer += chunk
    try {
      for (;;) {
        const index = this.buffer.indexOf("\n")
        const frame = index < 0 ? this.buffer : this.buffer.slice(0, index)
        if (Buffer.byteLength(frame) > (this.options.maxFrameBytes ?? 4_194_304))
          throw new Error("Codex frame exceeds output bound")
        if (index < 0) break
        this.buffer = this.buffer.slice(index + 1)
        if (!frame.trim()) continue
        this.dispatch(JSON.parse(frame))
      }
    } catch {
      this.fail(new Error("Malformed or oversized Codex protocol frame"))
    }
  }
  private dispatch(message: Record<string, unknown>): void {
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new Error("Invalid Codex frame")
    if (typeof message.method === "string") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params))
        throw new Error("Invalid Codex notification")
      for (const listener of this.listeners) listener(message as unknown as CodexMessage)
      return
    }
    if (typeof message.id !== "number") throw new Error("Invalid Codex envelope")
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code: number; message: string }
      entry.reject(new CodexRpcError(error.code, String(error.message)))
    } else if ("result" in message) entry.resolve(message.result)
    else entry.reject(new Error("Invalid Codex response"))
  }
  private send(message: unknown): void {
    if (this.failure) throw this.failure
    const data = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(data) + this.child.stdin.writableLength > 8_388_608)
      throw new Error("Codex input exceeds bound")
    this.child.stdin.write(data)
  }
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.size >= 128)
      return Promise.reject(new Error("Too many pending Codex requests"))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
        this.fail(new Error("Codex request timeout"))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  reply(id: string | number, result: unknown): void {
    this.send({ id, result })
  }
  reject(id: string | number, message = "Unsupported server request"): void {
    this.send({ id, error: { code: -32601, message } })
  }
  async initialize(): Promise<void> {
    if ((await readCodexVersion(this.options)) !== CODEX_PROTOCOL_VERSION)
      throw new Error("Unsupported Codex app-server version")
    await this.request("initialize", {
      clientInfo: { name: "jingler", title: "Jingler", version: "0.2.1" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    } satisfies InitializeParams)
    this.send({ method: "initialized", params: {} })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      stopChild(this.child, 250)
      await this.closed
    })()
    return this.closing
  }
}
