import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { stopChild, trackChild } from "./child-registry.js"
import {
  boundedCodexStderr,
  type CodexAppServerDiagnostics,
  createCodexStderrRecorder
} from "./codex-app-server-diagnostics.js"

export type JsonRpcId = number | string
export type JsonRpcMessage = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageId = (message: JsonRpcMessage): JsonRpcId | null => {
  const id = message.id
  return typeof id === "number" || typeof id === "string" ? id : null
}

const errorMessage = (error: unknown): string => {
  if (!isRecord(error)) return String(error)
  const message = error.message
  return typeof message === "string" ? message : JSON.stringify(error)
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
  readonly timeout: NodeJS.Timeout
  readonly method: string
  readonly startedAt: number
}

export interface CodexAppServerConnectionOptions {
  readonly requestTimeoutMs?: number
  readonly diagnostics?: CodexAppServerDiagnostics | null
}

export interface CodexAppServerRequestOptions {
  readonly timeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * A newline-delimited JSON-RPC 2.0 connection to Codex app-server.
 *
 * Responses are correlated here; notifications and server-initiated requests
 * remain ordered in `nextMessage()`, which lets the adapter process usage,
 * approvals, item deltas, and terminal events through one deterministic loop.
 */
export class CodexAppServerConnection {
  readonly #input: Writable
  readonly #output: Readable
  readonly #closeTransport: () => void
  readonly #requestTimeoutMs: number
  readonly #diagnostics: CodexAppServerDiagnostics | null
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #queued: Array<JsonRpcMessage> = []
  readonly #waiting: Array<(message: JsonRpcMessage | null) => void> = []
  #nextId = 1
  #buffer = ""
  #closed = false
  #failure: Error | null = null

  constructor(
    input: Writable,
    output: Readable,
    closeTransport: () => void,
    options: CodexAppServerConnectionOptions = {}
  ) {
    this.#input = input
    this.#output = output
    this.#closeTransport = closeTransport
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#diagnostics = options.diagnostics ?? null
    output.on("data", this.#onData)
    output.on("error", this.#onError)
    output.on("end", this.#onEnd)
    input.on("error", this.#onError)
  }

  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += chunk.toString()
    for (;;) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim().length === 0) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.recordDiagnostic("protocol.invalid_json", {
          bytes: Buffer.byteLength(line)
        })
        continue
      }
      if (isRecord(parsed)) this.#receive(parsed)
    }
  }

  readonly #onError = (cause: Error): void => {
    this.#finish(cause)
  }

  readonly #onEnd = (): void => {
    this.#finish(null)
  }

  #receive(message: JsonRpcMessage): void {
    const id = messageId(message)
    if (id !== null && message.method === undefined) {
      const pending = this.#pending.get(id)
      if (pending === undefined) {
        this.recordDiagnostic("response.unmatched", { requestId: String(id) })
        return
      }
      this.#pending.delete(id)
      clearTimeout(pending.timeout)
      this.recordDiagnostic(message.error === undefined ? "request.completed" : "request.failed", {
        method: pending.method,
        requestId: String(id),
        durationMs: Date.now() - pending.startedAt
      })
      if (message.error !== undefined) {
        pending.reject(new Error(errorMessage(message.error)))
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }

    this.recordDiagnostic("protocol.message", {
      method: typeof message.method === "string" ? message.method : "<unknown>",
      serverRequest: id !== null,
      queued: this.#waiting.length === 0
    })
    const waiter = this.#waiting.shift()
    if (waiter !== undefined) waiter(message)
    else this.#queued.push(message)
  }

  #finish(cause: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = cause
    this.recordDiagnostic("transport.closed", {
      failed: cause !== null,
      pendingRequests: this.#pending.size,
      queuedMessages: this.#queued.length,
      waitingConsumers: this.#waiting.length
    })
    this.#output.off("data", this.#onData)
    this.#output.off("error", this.#onError)
    this.#output.off("end", this.#onEnd)
    this.#input.off("error", this.#onError)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause ?? new Error("Codex app-server closed"))
    }
    this.#pending.clear()
    for (const waiter of this.#waiting.splice(0)) waiter(null)
  }

  #send(message: JsonRpcMessage): void {
    if (this.#closed) throw this.#failure ?? new Error("Codex app-server is closed")
    this.#input.write(`${JSON.stringify(message)}\n`)
  }

  request(
    method: string,
    params: unknown,
    options: CodexAppServerRequestOptions = {}
  ): Promise<unknown> {
    const id = this.#nextId
    this.#nextId += 1
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        this.recordDiagnostic("request.timeout", {
          method,
          requestId: String(id),
          durationMs: Date.now() - startedAt
        })
        reject(new Error(`Codex app-server request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref()
      this.#pending.set(id, { resolve, reject, timeout, method, startedAt })
      this.recordDiagnostic("request.sent", {
        method,
        requestId: String(id),
        timeoutMs
      })
      try {
        this.#send({ jsonrpc: "2.0", id, method, params })
      } catch (cause) {
        this.#pending.delete(id)
        clearTimeout(timeout)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.recordDiagnostic("notification.sent", { method })
    this.#send({ jsonrpc: "2.0", method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.recordDiagnostic("server_request.responded", {
      requestId: String(id),
      failed: false
    })
    this.#send({ jsonrpc: "2.0", id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.recordDiagnostic("server_request.responded", {
      requestId: String(id),
      failed: true,
      errorCode: code
    })
    this.#send({ jsonrpc: "2.0", id, error: { code, message } })
  }

  recordDiagnostic(
    event: string,
    fields: Readonly<Record<string, boolean | number | string | null | undefined>> = {}
  ): void {
    this.#diagnostics?.record(event, fields)
  }

  get diagnosticsPath(): string | null {
    return this.#diagnostics?.path ?? null
  }

  nextMessage(): Promise<JsonRpcMessage | null> {
    const queued = this.#queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#closed) return Promise.resolve(null)
    return new Promise((resolve) => this.#waiting.push(resolve))
  }

  /**
   * Wait for one notification without leaving a stale waiter behind on timeout.
   * Used for request-adjacent notifications whose delivery is not atomic with
   * the JSON-RPC response.
   */
  nextMessageWithin(timeoutMs: number): Promise<JsonRpcMessage | null> {
    const queued = this.#queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const waiter = (message: JsonRpcMessage | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(message)
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        const index = this.#waiting.indexOf(waiter)
        if (index >= 0) this.#waiting.splice(index, 1)
        resolve(null)
      }, timeoutMs)
      timeout.unref()
      this.#waiting.push(waiter)
    })
  }

  /** Take notifications already delivered with a request response without waiting. */
  drainMessages(): ReadonlyArray<JsonRpcMessage> {
    return this.#queued.splice(0)
  }

  close(): void {
    if (this.#closed) return
    this.recordDiagnostic("transport.close_requested")
    this.#closeTransport()
    this.#finish(null)
  }
}

export interface StartCodexAppServerOptions {
  readonly binPath?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly diagnostics?: CodexAppServerDiagnostics | null
  /**
   * Codex `-c key=value` config overrides, prepended before `app-server` — used to
   * inject the unified OpenConnector MCP server (see `codexMcpOverrides`). Each
   * entry becomes a separate `-c <entry>` argv pair. Empty by default.
   */
  readonly configOverrides?: ReadonlyArray<string>
}

/** Spawn and initialize one app-server connection for one Jingler run. */
export const startCodexAppServer = async (
  options: StartCodexAppServerOptions
): Promise<CodexAppServerConnection> => {
  const args = [
    ...(options.configOverrides ?? []).flatMap((override) => ["-c", override]),
    "app-server"
  ]
  const child = trackChild(
    spawn(options.binPath || "codex", args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    })
  )
  options.diagnostics?.record("process.spawned", {
    pid: child.pid ?? null
  })
  if (child.stdin === null || child.stdout === null) {
    stopChild(child)
    throw new Error("Codex app-server did not expose stdio")
  }
  const connection = new CodexAppServerConnection(
    child.stdin,
    child.stdout,
    () => stopChild(child),
    { diagnostics: options.diagnostics }
  )
  const stderrRecorder = createCodexStderrRecorder(options.diagnostics)
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrRecorder.append(chunk)
  })
  child.stderr?.on("end", () => stderrRecorder.flush())
  child.on("error", (cause) => {
    stderrRecorder.flush()
    options.diagnostics?.record("process.error", {
      message: boundedCodexStderr(cause.message)
    })
    connection.close()
  })
  child.on("exit", (code, signal) => {
    stderrRecorder.flush()
    options.diagnostics?.record("process.exit", { code, signal })
    connection.close()
  })

  try {
    await connection.request("initialize", {
      clientInfo: { name: "jingler", version: "1" },
      capabilities: { experimentalApi: true }
    })
    connection.notify("initialized", {})
    return connection
  } catch (cause) {
    connection.close()
    throw cause
  }
}
