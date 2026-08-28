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
