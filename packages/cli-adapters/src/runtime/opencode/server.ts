import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { execFileText, stopChild, trackChild } from "../../child-registry.js"
import { nativeCliEnvironment } from "../providers/native-cli-environment.js"

/** Minimum and maximum tested server are deliberately the same release. */
export const OPENCODE_VERSION = "1.18.14"
export class UnsupportedOpenCode extends Error {}
export interface OpenCodeOptions {
  binary?: string
  environment?: NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
  fetch?: typeof globalThis.fetch
  port?: () => Promise<number>
  timeoutMs?: number
}
export const openCodeEnvironment = (environment: NodeJS.ProcessEnv) => ({
  ...nativeCliEnvironment(environment),
  ...Object.fromEntries(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE"].flatMap(
    (name) => environment[name] === undefined ? [] : [[name, environment[name]]]
  ))
})
export const supportedPlatform = () => {
  if (process.platform === "win32") throw new UnsupportedOpenCode("OpenCode requires owned POSIX process groups; Windows Job Object cleanup is unavailable")
}
export const readOpenCodeVersion = async (options: OpenCodeOptions = {}) => {
  supportedPlatform()
  const stdout = await execFileText(options.binary ?? process.env.JINGLER_OPENCODE_BINARY ?? "opencode", ["--version"], {
    env: openCodeEnvironment(options.environment ?? process.env), timeout: 5_000, maxBuffer: 64_000
  })
  return stdout.trim()
}
const ephemeralPort = () => new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close((error) => {
      if (error) reject(error)
      else if (address && typeof address !== "string") resolve(address.port)
      else reject(new Error("Could not allocate loopback port"))
    })
  })
})

/** Bound raw bytes before the SDK's JSON/SSE parser can accumulate them. */
export const boundedResponse = (response: Response): Response => {
  if (!response.body) return response
  const sse = response.headers.get("content-type")?.includes("text/event-stream")
  let bytes = 0
  let newline = false
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: byte framing must retain CRLF boundary state across chunks.
    transform(chunk, controller) {
      for (const byte of chunk) {
        bytes++
        if (bytes > (sse ? 1_048_576 : 8_388_608)) throw new Error("OpenCode response exceeds bound")
        if (sse && byte !== 13) {
          if (byte === 10 && newline) bytes = 0
          newline = byte === 10
        }
      }
      controller.enqueue(chunk)
    }
  })), { status: response.status, statusText: response.statusText, headers: response.headers })
}

const waitUntilReady = async (client: ReturnType<typeof createOpencodeClient>, stopped: AbortSignal, spawned: Promise<void>, failed: () => boolean, timeoutMs: number) => {
  await spawned
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !failed() && !stopped.aborted) {
    try {
      const result = await client.global.health({ signal: AbortSignal.timeout(500) })
      if (result.data) {
        if (!result.data.healthy || result.data.version !== OPENCODE_VERSION) throw new UnsupportedOpenCode("OpenCode health/version mismatch")
        return
      }
    } catch (error) {
      if (error instanceof UnsupportedOpenCode) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("OpenCode server failed readiness")
}

export class OpenCodeServer {
  readonly stopped = new AbortController()
  private closing?: Promise<void>
  private constructor(
    readonly client: ReturnType<typeof createOpencodeClient>,
    private readonly child: ChildProcess,
    private readonly closed: Promise<void>
  ) {}
  static async start(options: OpenCodeOptions = {}) {
    if (await readOpenCodeVersion(options) !== OPENCODE_VERSION)
      throw new UnsupportedOpenCode(`OpenCode requires tested server ${OPENCODE_VERSION}`)
    const port = await (options.port ?? ephemeralPort)()
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid loopback port")
    const password = randomBytes(32).toString("base64url")
    const child = trackChild((options.spawnProcess ?? spawn)(options.binary ?? process.env.JINGLER_OPENCODE_BINARY ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...openCodeEnvironment(options.environment ?? process.env), OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"], detached: true
    }), true)
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    child.stdout?.resume()
    child.stderr?.resume()
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    let failed = false
    child.once("error", () => { failed = true })
    const baseUrl = `http://127.0.0.1:${port}`
    let server: OpenCodeServer
    const client = createOpencodeClient({ baseUrl,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        if (new URL(request.url).origin !== baseUrl) throw new Error("Foreign OpenCode endpoint")
        const stream = new URL(request.url).pathname === "/global/event"
        const signal = AbortSignal.any([request.signal, server.stopped.signal, ...(stream ? [] : [AbortSignal.timeout(options.timeoutMs ?? 30_000)])])
        return boundedResponse(await (options.fetch ?? globalThis.fetch)(new Request(request, { signal, redirect: "error" })))
      }
    })
    server = new OpenCodeServer(client, child, closed)
    child.once("close", () => server.stopped.abort())
    try {
      await waitUntilReady(client, server.stopped.signal, spawned, () => failed, options.timeoutMs ?? 15_000)
      return server
    } catch (error) {
      await server.close()
      throw error
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped.abort()
      stopChild(this.child, 250)
      await this.closed
    })()
    return this.closing
  }
}

/** One owned endpoint per target, shared by concurrent turns and discovery. */
export const makeOpenCodePool = (options: OpenCodeOptions = {}) => {
  const servers = new Map<string, { promise: Promise<OpenCodeServer>; leases: number }>()
  return async (target: string) => {
    let entry = servers.get(target)
    if (!entry) {
      entry = { promise: OpenCodeServer.start(options), leases: 0 }
      servers.set(target, entry)
    }
    const owned = entry
    owned.leases++
    let released = false
    const release = async () => {
      if (released) return
      released = true
      if (--owned.leases === 0) {
        servers.delete(target)
        await owned.promise.then((server) => server.close(), () => {})
      }
    }
    try { return { server: await owned.promise, release } }
    catch (error) { await release(); throw error }
  }
}
export const acquireOpenCode = makeOpenCodePool()
