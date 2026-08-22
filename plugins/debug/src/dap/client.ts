/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- DAP framing parses untrusted JSON messages before dispatch. */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createConnection, createServer, type Socket } from "node:net"
import type {
  DapEvent,
  DapMessage,
  DapRequest,
  DapResolvedAdapter,
  DapResponse,
  DapTransport,
  JsonObject
} from "./types.js"

const CONTENT_LENGTH = /(?:^|\r\n)Content-Length:\s*(\d+)/iu
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const DAP_PORT_ARGUMENT = String.raw`\${port}`

const frame = (message: DapMessage): string => {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

const killTree = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()))
    return
  }
  try { if (child.pid) process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))])
  if (child.exitCode !== null || child.signalCode !== null) return
  try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
}

const stdioTransport = async (
  adapter: DapResolvedAdapter,
  cwd: string
): Promise<DapTransport> => {
  const child = spawn(adapter.commandPath, [...adapter.args], {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CI: "1", NO_COLOR: "1" }
  })
  await Promise.race([
    once(child, "spawn"),
    once(child, "error").then(([cause]) => Promise.reject(cause))
  ])
  return {
    process: child,
    write: (message) => new Promise((resolve, reject) =>
      child.stdin.write(message, (error) => error ? reject(error) : resolve())
    ),
    onData: (listener) => child.stdout.on("data", listener),
    dispose: () => killTree(child)
  }
}

const reservePort = async (): Promise<number> => {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve a DAP port.")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

const connectWithRetry = async (port: number, deadline = Date.now() + 10_000): Promise<Socket> => {
  const socket = createConnection({ host: "127.0.0.1", port })
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([cause]) => Promise.reject(cause))
    ])
    return socket
  } catch (cause) {
    socket.destroy()
    if (Date.now() >= deadline) throw cause
    await new Promise((resolve) => setTimeout(resolve, 50))
    return connectWithRetry(port, deadline)
  }
}

const tcpTransport = async (adapter: DapResolvedAdapter, cwd: string): Promise<DapTransport> => {
  const port = await reservePort()
  const child = spawn(
    adapter.commandPath,
    adapter.args.map((argument) => argument.replaceAll(DAP_PORT_ARGUMENT, String(port))),
    {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1" }
    }
  )
  await Promise.race([
    once(child, "spawn"),
    once(child, "error").then(([cause]) => Promise.reject(cause))
  ])
  let socket: Socket
  try {
    socket = await connectWithRetry(port)
    socket.on("error", () => {})
  } catch (cause) {
    await killTree(child)
    throw cause
  }
  return {
    process: child,
    write: (message) => new Promise((resolve, reject) =>
      socket.write(message, (error) => error ? reject(error) : resolve())
    ),
    onData: (listener) => socket.on("data", listener),
    dispose: async () => {
      socket.destroy()
      await killTree(child)
    }
  }
}

type EventHandler = (event: DapEvent) => void

export class DapClient {
  readonly #transport: DapTransport
  readonly #pending = new Map<number, {
    resolve: (response: DapResponse) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  readonly #handlers = new Set<EventHandler>()
  #sequence = 0
  #buffer = Buffer.alloc(0)
  #disposed = false
  readonly #debuggees = new Set<ChildProcess>()

  private constructor(transport: DapTransport) {
    this.#transport = transport
    transport.onData((chunk) => {
      try {
        this.#read(chunk)
      } catch (cause) {
        this.#failPending(cause instanceof Error ? cause : new Error(String(cause)))
        this.dispose().catch(() => {})
      }
    })
    transport.process.stderr.on("data", (chunk: Buffer) => {
      this.#emit({ seq: 0, type: "event", event: "output", body: { category: "stderr", output: chunk.toString() } })
    })
    transport.process.on("exit", (code) => {
      this.#emit({ seq: 0, type: "event", event: "terminated", body: { exitCode: code ?? undefined } })
      this.#failPending(new Error("Debug adapter exited."))
    })
  }

  static async spawn(adapter: DapResolvedAdapter, cwd: string): Promise<DapClient> {
    if (adapter.connectMode === "socket") {
      throw new Error(`Adapter ${adapter.name} requires a platform socket transport; configure it for stdio or tcp.`)
    }
    return new DapClient(await (adapter.connectMode === "tcp"
      ? tcpTransport(adapter, cwd)
      : stdioTransport(adapter, cwd)))
  }

  onEvent(handler: EventHandler): () => void {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  async request(command: string, args: JsonObject = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.#disposed) throw new Error("Debug adapter is closed.")
    if (signal?.aborted) throw new Error("Debug request was cancelled.")
    const seq = ++this.#sequence
    const request: DapRequest = { seq, type: "request", command, arguments: args }
    const pending = new Promise<DapResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq)
        reject(new Error(`DAP ${command} timed out.`))
      }, timeoutMs)
      this.#pending.set(seq, { resolve, reject, timer })
    })
    const abort = () => {
      const entry = this.#pending.get(seq)
      if (!entry) return
      clearTimeout(entry.timer)
      this.#pending.delete(seq)
      entry.reject(new Error("Debug request was cancelled."))
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      try {
        await this.#transport.write(frame(request))
      } catch (cause) {
        abort()
        await pending.catch(() => {})
        throw cause
      }
      const response = await pending
      if (!response.success) throw new Error(response.message || `DAP ${command} failed.`)
      return response.body ?? {}
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }

  async respond(request: DapRequest, success: boolean, body: JsonObject = {}, message?: string): Promise<void> {
    const response: DapResponse = {
      seq: ++this.#sequence,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success,
      body,
      ...(message ? { message } : {})
    }
    await this.#transport.write(frame(response))
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#failPending(new Error("Debug adapter was closed."))
    await Promise.all([...this.#debuggees].map(killTree))
    this.#debuggees.clear()
    await this.#transport.dispose()
  }

  #emit(event: DapEvent): void {
    for (const handler of this.#handlers) handler(event)
  }

  #failPending(cause: Error): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(cause)
    }
    this.#pending.clear()
  }

  async #runInTerminal(request: DapRequest): Promise<void> {
    const args = request.arguments?.args
    if (!(Array.isArray(args) && args.every((value): value is string => typeof value === "string")) || args.length === 0) {
      throw new Error("runInTerminal requires a command argument list.")
    }
    const cwd = typeof request.arguments?.cwd === "string" ? request.arguments.cwd : process.cwd()
    const requestedEnv = request.arguments?.env
    const env = requestedEnv && typeof requestedEnv === "object" && !Array.isArray(requestedEnv)
      ? Object.fromEntries(Object.entries(requestedEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {}
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env }
    })
    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([cause]) => Promise.reject(cause))
    ])
    this.#debuggees.add(child)
    child.once("exit", () => this.#debuggees.delete(child))
    await this.respond(request, true, { processId: child.pid })
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.length > MAX_MESSAGE_BYTES + 8_192) throw new Error("DAP message exceeded 16 MiB.")
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const header = this.#buffer.subarray(0, headerEnd).toString()
      const match = CONTENT_LENGTH.exec(header)
      if (!match) throw new Error("Invalid DAP message header.")
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        throw new Error("Invalid DAP Content-Length.")
      }
      const bodyStart = headerEnd + 4
      if (this.#buffer.length < bodyStart + length) return
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString()
      this.#buffer = this.#buffer.subarray(bodyStart + length)
      const message = JSON.parse(body) as DapMessage
      if (message.type === "response") {
        const response = message as DapResponse
        const pending = this.#pending.get(response.request_seq)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.#pending.delete(response.request_seq)
        pending.resolve(response)
      } else if (message.type === "event") {
        this.#emit(message as DapEvent)
      } else if (message.type === "request") {
        const request = message as DapRequest
        if (request.command === "runInTerminal") {
          this.#runInTerminal(request).catch((cause: unknown) => {
            this.respond(request, false, {}, cause instanceof Error ? cause.message : String(cause)).catch(() => {})
          })
        } else {
          this.respond(request, false, {}, `Unsupported reverse request: ${request.command}`).catch(() => {})
        }
      }
    }
  }
}
