import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { expect, test } from "./fixtures.js"

/**
 * The dev-mode performance monitor's one externally observable contract: when
 * the app runs un-packaged with the monitor enabled, it writes a discovery
 * file agents can find and serves an authenticated /status over loopback.
 *
 * Headless e2e normally disables the monitor (same switch as codex
 * diagnostics); `JINGLER_PERF_MONITOR=1` is the documented force-on that this
 * test exercises. The built e2e renderer has no dev perf hook, so this
 * asserts the DEGRADED contract — status responds and reports whether CDP
 * attached — not renderer-hook metrics.
 */
test("perf monitor serves its agent API in dev", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    e2eEnv: { JINGLER_PERF_MONITOR: "1" }
  })

  const endpointFile = join(launched.home, "jingler", "diagnostics", "perf", "endpoint.json")
  await expect
    .poll(() => existsSync(endpointFile), { timeout: 15_000 })
    .toBe(true)

  const endpoint = JSON.parse(readFileSync(endpointFile, "utf8")) as {
    port: number
    token: string
  }
  expect(endpoint.port).toBeGreaterThan(0)

  const unauthorized = await fetch(`http://127.0.0.1:${endpoint.port}/status`)
  expect(unauthorized.status).toBe(401)

  const response = await fetch(`http://127.0.0.1:${endpoint.port}/status`, {
    headers: { authorization: `Bearer ${endpoint.token}` }
  })
  expect(response.status).toBe(200)
  const status = (await response.json()) as { cdpAttached: boolean; sampleIntervalMs: number }
  expect(typeof status.cdpAttached).toBe("boolean")
  expect(status.sampleIntervalMs).toBeGreaterThan(0)

  const metrics = await fetch(`http://127.0.0.1:${endpoint.port}/metrics`, {
    headers: { authorization: `Bearer ${endpoint.token}` }
  })
  expect(metrics.status).toBe(200)
  const sample = (await metrics.json()) as { main: { rss: number }; processes: unknown[] }
  expect(sample.main.rss).toBeGreaterThan(0)
  expect(Array.isArray(sample.processes)).toBe(true)
})

/**
 * The memory-infra dump is the one probe that does not go through the
 * renderer's debugger slot, so it must work in the degraded (no-CDP) e2e
 * build too. Asserts the contract the CLI summarizer depends on: the trace
 * carries at least one detailed dump whose allocator map names PartitionAlloc
 * and V8 for some process.
 */
test("perf monitor captures a memory-infra dump with per-allocator sizes", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    e2eEnv: { JINGLER_PERF_MONITOR: "1" }
  })
  const endpointFile = join(launched.home, "jingler", "diagnostics", "perf", "endpoint.json")
  await expect.poll(() => existsSync(endpointFile), { timeout: 15_000 }).toBe(true)
  const endpoint = JSON.parse(readFileSync(endpointFile, "utf8")) as { port: number; token: string }

  const response = await fetch(`http://127.0.0.1:${endpoint.port}/memory-dump`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify({ dumps: 1, intervalMs: 1000 })
  })
  expect(response.status).toBe(200)
  const { path, dumps } = (await response.json()) as { path: string; dumps: number }
  expect(dumps).toBe(1)
  expect(path.startsWith(join(launched.home, "jingler", "diagnostics", "perf"))).toBe(true)
  expect(existsSync(path)).toBe(true)

  const trace = JSON.parse(readFileSync(path, "utf8")) as {
    traceEvents?: Array<{ ph: string; pid: number; args?: { dumps?: { allocators?: Record<string, unknown> } } }>
  }
  const events = Array.isArray(trace) ? trace : (trace.traceEvents ?? [])
  const memoryDumps = events.filter((event) => event.ph === "v" && event.args?.dumps?.allocators)
  expect(memoryDumps.length).toBeGreaterThan(0)
  const allocatorPaths = new Set(memoryDumps.flatMap((event) => Object.keys(event.args?.dumps?.allocators ?? {})))
  expect([...allocatorPaths].some((p) => p.startsWith("partition_alloc"))).toBe(true)
  expect([...allocatorPaths].some((p) => p.startsWith("v8"))).toBe(true)
})
