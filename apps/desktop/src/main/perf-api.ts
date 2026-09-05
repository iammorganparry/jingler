/**
 * The agent-facing surface of the dev-mode performance monitor: a loopback
 * HTTP JSON API plus the discovery file that tells agents where it is.
 *
 * Shape follows `packages/cli-adapters/src/memory-mcp-proxy.ts` — the repo's
 * existing loopback-server precedent: `127.0.0.1` only, OS-assigned port, a
 * per-instance random bearer token compared in constant time, and
 * `closeAllConnections()` teardown. Discovery is a `endpoint.json` (mode
 * 0600) under `~/jingler/diagnostics/perf/` that `pnpm perf` reads; the token
 * never appears on the command line or in logs.
 *
 * Electron-free on purpose: every capability is injected through
 * `PerfApiDeps`, so the routing/auth layer unit-tests as a plain node:http
 * server (see perf-api.test.ts).
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const LOOPBACK_HOST = "127.0.0.1"
const MAX_REQUEST_BYTES = 1024 * 1024

export interface PerfSample {
  readonly t: number
  /**
   * OS pid of the app window's renderer. `processes` lists every Tab process
   * — native preview views included — in whatever order Chromium hands them
   * back, so "the first Tab" is a different process from sample to sample.
   * Absent when no window is alive.
   */
  readonly rendererPid?: number
  readonly main: {
    readonly rss: number
    readonly heapUsed: number
    readonly external: number
    readonly arrayBuffers: number
  }
  readonly processes: ReadonlyArray<{
    readonly type: string
    readonly pid: number
    readonly workingSetKb: number
    readonly cpuPercent: number
  }>
  readonly renderer?: {
    readonly usedSize: number
    readonly embedderHeapUsedSize: number
    readonly backingStorageSize: number
    readonly documents: number
    readonly nodes: number
    readonly jsEventListeners: number
  }
  readonly app?: {
    readonly actors: number
    readonly queryCache: number
    readonly xterm: number
    readonly longTasks: number
    readonly loopLagP95: number
  }
}

export interface PerfApiDeps {
  status(): Record<string, unknown>
  metrics(): Promise<PerfSample>
  history(limit: number): ReadonlyArray<PerfSample>
  gc(): Promise<void>
  heapSnapshot(label: string | undefined): Promise<{ path: string }>
  cpuProfileStart(): Promise<{ ok: true }>
  cpuProfileStop(): Promise<{ path: string }>
  allocStart(): Promise<{ ok: true }>
  allocStop(): Promise<{ path: string }>
  rendersStart(showToolbar: boolean): Promise<unknown>
  rendersStop(): Promise<unknown>
  rendersReport(): Promise<unknown>
  leakCheck(options: { warmupMs?: number; settleMs?: number }): Promise<unknown>
  /** memory-infra trace (per-process allocator breakdown) — see perf-memory-dump.ts. */
  memoryDump(options: { dumps?: number; intervalMs?: number }): Promise<{ path: string; dumps: number }>
}

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

const respond = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json"
  })
  response.end(JSON.stringify(body))
}

const bodyOf = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error("request body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const parseBody = (raw: string): Record<string, unknown> => {
  if (raw.length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

const UNSAFE_LABEL_CHARS = /[^\w-]/g

interface RouteContext {
  readonly url: URL
  readonly body: () => Promise<Record<string, unknown>>
}

type Route = (deps: PerfApiDeps, ctx: RouteContext) => Promise<unknown>

/** Route table keyed by "METHOD /path" — one small handler per endpoint. */
const ROUTES: Readonly<Record<string, Route>> = {
  "GET /status": (deps) => Promise.resolve(deps.status()),
  "GET /metrics": (deps) => deps.metrics(),
  "GET /history": (deps, { url }) => {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 120), 5000))
    return Promise.resolve({ samples: deps.history(limit) })
  },
  "POST /gc": async (deps) => {
    await deps.gc()
    return { ok: true }
  },
  "POST /heap-snapshot": async (deps, ctx) => {
    const body = await ctx.body()
    const label =
      typeof body.label === "string" ? body.label.replace(UNSAFE_LABEL_CHARS, "") : undefined
    return deps.heapSnapshot(label)
  },
  "POST /cpu-profile/start": (deps) => deps.cpuProfileStart(),
  "POST /cpu-profile/stop": (deps) => deps.cpuProfileStop(),
  "POST /alloc/start": (deps) => deps.allocStart(),
  "POST /alloc/stop": (deps) => deps.allocStop(),
  "POST /renders/start": async (deps, ctx) => {
    const body = await ctx.body()
    return deps.rendersStart(body.showToolbar === true)
  },
  "POST /renders/stop": (deps) => deps.rendersStop(),
  "GET /renders/report": (deps) => deps.rendersReport(),
  "POST /leak-check": async (deps, ctx) => {
    const body = await ctx.body()
    return deps.leakCheck({
      warmupMs: typeof body.warmupMs === "number" ? body.warmupMs : undefined,
      settleMs: typeof body.settleMs === "number" ? body.settleMs : undefined
    })
  },
  "POST /memory-dump": async (deps, ctx) => {
    const body = await ctx.body()
    return deps.memoryDump({
      dumps: typeof body.dumps === "number" ? body.dumps : undefined,
      intervalMs: typeof body.intervalMs === "number" ? body.intervalMs : undefined
    })
  }
}

export const createPerfRequestHandler = (token: string, deps: PerfApiDeps): RequestListener => {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!sameSecret(request.headers.authorization, `Bearer ${token}`)) {
      respond(response, 401, { error: "unauthorized" })
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const routeKey = `${request.method ?? "GET"} ${url.pathname}`
    const route = ROUTES[routeKey]
    if (route === undefined) {
      respond(response, 404, { error: `unknown route: ${routeKey}` })
      return
    }
    try {
      const ctx: RouteContext = { url, body: async () => parseBody(await bodyOf(request)) }
      respond(response, 200, await route(deps, ctx))
    } catch (cause) {
      respond(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return (request, response) => {
    handle(request, response).catch(() => response.destroy())
  }
}

export interface PerfApiHandle {
  readonly port: number
  readonly stop: () => void
}

/**
 * Start the API and write the discovery file. `root` must already exist.
 */
export const startPerfApi = (root: string, deps: PerfApiDeps): Promise<PerfApiHandle> =>
  new Promise((resolve, reject) => {
    const token = randomBytes(24).toString("hex")
    const server = createServer(createPerfRequestHandler(token, deps))
    server.on("error", reject)
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const { port } = server.address() as AddressInfo
      const endpointFile = join(root, "endpoint.json")
      writeFileSync(
        endpointFile,
        JSON.stringify(
          { port, token, pid: process.pid, startedAt: new Date().toISOString() },
          null,
          2
        ),
        { mode: 0o600 }
      )
      resolve({
        port,
        stop: () => {
          try {
            unlinkSync(endpointFile)
          } catch {
            // Already gone — nothing to clean up.
          }
          server.closeAllConnections()
          server.close()
        }
      })
    })
  })
