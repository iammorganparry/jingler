import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startPerfApi, type PerfApiDeps, type PerfSample } from "./perf-api.js"

const TOKEN_SHAPE = /^[0-9a-f]{48}$/

const sample: PerfSample = {
  t: 1,
  main: { rss: 1, heapUsed: 1, external: 1, arrayBuffers: 1 },
  processes: []
}

const makeDeps = (overrides: Partial<PerfApiDeps> = {}): PerfApiDeps => ({
  status: () => ({ ok: true }),
  metrics: () => Promise.resolve(sample),
  history: (limit) => Array.from({ length: Math.min(limit, 3) }, () => sample),
  gc: () => Promise.resolve(),
  heapSnapshot: (label) => Promise.resolve({ path: `/snap/${label ?? "unlabelled"}` }),
  cpuProfileStart: () => Promise.resolve({ ok: true }),
  cpuProfileStop: () => Promise.resolve({ path: "/prof" }),
  allocStart: () => Promise.resolve({ ok: true }),
  allocStop: () => Promise.resolve({ path: "/alloc" }),
  rendersStart: () => Promise.resolve({ ok: true }),
  rendersStop: () => Promise.resolve({ ok: true }),
  rendersReport: () => Promise.resolve({ components: [] }),
  leakCheck: () => Promise.resolve({ workdir: "/leak" }),
  memoryDump: (options) => Promise.resolve({ path: `/dump/${options.dumps ?? "default"}`, dumps: options.dumps ?? 1 }),
  ...overrides
})

interface Ctx {
  root: string
  port: number
  token: string
  stop: () => void
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const start = async (deps: PerfApiDeps = makeDeps()): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), "perf-api-"))
  const api = await startPerfApi(root, deps)
  const endpoint = JSON.parse(readFileSync(join(root, "endpoint.json"), "utf8")) as {
    port: number
    token: string
  }
  cleanups.push(() => {
    api.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, port: api.port, token: endpoint.token, stop: api.stop }
}

const call = (
  ctx: Ctx,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
) =>
  fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token ?? ctx.token}`,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })

describe("perf API", () => {
  it("writes a discovery file whose port matches the listener", async () => {
    const ctx = await start()
    const endpoint = JSON.parse(readFileSync(join(ctx.root, "endpoint.json"), "utf8"))
    expect(endpoint.port).toBe(ctx.port)
    expect(endpoint.token).toMatch(TOKEN_SHAPE)
  })

  it("rejects a missing or wrong bearer token", async () => {
    const ctx = await start()
    const bad = await call(ctx, "GET", "/status", { token: "wrong" })
    expect(bad.status).toBe(401)
    const none = await fetch(`http://127.0.0.1:${ctx.port}/status`)
    expect(none.status).toBe(401)
  })

  it("serves status, metrics, and clamped history", async () => {
    const ctx = await start()
    expect(await (await call(ctx, "GET", "/status")).json()).toEqual({ ok: true })
    const metrics = (await (await call(ctx, "GET", "/metrics")).json()) as PerfSample
    expect(metrics.t).toBe(1)
    const history = (await (await call(ctx, "GET", "/history?limit=2")).json()) as {
      samples: PerfSample[]
    }
    expect(history.samples).toHaveLength(2)
  })

  it("404s unknown routes", async () => {
    const ctx = await start()
    expect((await call(ctx, "GET", "/nope")).status).toBe(404)
    // Right path, wrong method is also unknown.
    expect((await call(ctx, "GET", "/heap-snapshot")).status).toBe(404)
  })

  it("sanitizes snapshot labels", async () => {
    const ctx = await start()
    const result = (await (
      await call(ctx, "POST", "/heap-snapshot", { body: { label: "../../etc/passwd" } })
    ).json()) as { path: string }
    expect(result.path).toBe("/snap/etcpasswd")
  })

  it("surfaces dependency failures as 500 with the message", async () => {
    const ctx = await start(
      makeDeps({ cpuProfileStop: () => Promise.reject(new Error("no profile started")) })
    )
    const response = await call(ctx, "POST", "/cpu-profile/stop")
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toBe("no profile started")
  })

  it("stop() removes the discovery file and closes the port", async () => {
    const ctx = await start()
    ctx.stop()
    expect(existsSync(join(ctx.root, "endpoint.json"))).toBe(false)
    await expect(call(ctx, "GET", "/status")).rejects.toThrow()
  })
})

describe("perf API memory dumps", () => {
  it("forwards memory-dump options and defaults them when absent", async () => {
    const ctx = await start()
    const explicit = (await (
      await call(ctx, "POST", "/memory-dump", { body: { dumps: 3, intervalMs: 1000 } })
    ).json()) as { path: string; dumps: number }
    expect(explicit).toEqual({ path: "/dump/3", dumps: 3 })
    const defaulted = (await (await call(ctx, "POST", "/memory-dump")).json()) as { path: string }
    expect(defaulted.path).toBe("/dump/default")
  })
})
