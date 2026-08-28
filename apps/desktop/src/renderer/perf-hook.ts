/**
 * Renderer half of the dev-mode performance monitor.
 *
 * Imported from main.tsx behind `import.meta.env.DEV` only — packaged
 * renderer bundles tree-shake this module (and the react-scan dependency it
 * lazily imports) away entirely. Everything is published on
 * `globalThis.__jinglerPerf`, which the main-process monitor reads over CDP
 * (`Runtime.evaluate`) during passive sampling and render-tracking requests.
 *
 * Two caveats agents reading these numbers must know:
 * - StrictMode is always on in dev, so mount-effect counts double; render
 *   counts from react-scan are per-commit and unaffected.
 * - The passive `snapshot()` must stay cheap — it runs every ~20s from the
 *   sampler. Nothing here may force layout; `querySelectorAll` on a class is
 *   a DOM-tree walk, not a layout, and the transcript keeps it small.
 */
import { __debugActorCount } from "./conversation-registry.js"
import { queryClient } from "./query-client.js"

interface RenderStat {
  name: string
  count: number
  /** Renders react-scan classified as unnecessary (no output change). */
  unnecessary: number
  totalTimeMs: number
}

interface RendersReport {
  tracking: boolean
  startedAt: number | null
  components: RenderStat[]
}

/** Rolling event-loop-lag samples; p95 over the last window. */
const LAG_WINDOW = 250
const LAG_TICK_MS = 100
const lagSamples: number[] = []
let expected = performance.now() + LAG_TICK_MS
// Deliberately never cleared: this module lives exactly as long as the page.
window.setInterval(() => {
  const now = performance.now()
  lagSamples.push(Math.max(0, now - expected))
  if (lagSamples.length > LAG_WINDOW) lagSamples.shift()
  expected = now + LAG_TICK_MS
}, LAG_TICK_MS)

const loopLagP95 = (): number => {
  if (lagSamples.length === 0) return 0
  const sorted = [...lagSamples].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0)
}

/** Long tasks since page load — same pattern as e2e/perf-bench.spec.ts. */
let longTaskCount = 0
try {
  new PerformanceObserver((list) => {
    longTaskCount += list.getEntries().length
  }).observe({ entryTypes: ["longtask"] })
} catch {
  // longtask observation unsupported — counter stays 0.
}

/** react-scan render aggregation, active only between start() and stop(). */
const renderStats = new Map<string, RenderStat>()
let tracking = false
let trackingStartedAt: number | null = null

interface ScanModule {
  scan(options: Record<string, unknown>): void
  setOptions(options: Record<string, unknown>): void
}
let scanModule: ScanModule | null = null

const recordRender = (name: string, timeMs: number, unnecessary: boolean): void => {
  const stat = renderStats.get(name) ?? { name, count: 0, unnecessary: 0, totalTimeMs: 0 }
  stat.count += 1
  if (unnecessary) stat.unnecessary += 1
  stat.totalTimeMs += timeMs
  renderStats.set(name, stat)
}

const rendersStart = async (options?: { showToolbar?: boolean }): Promise<string> => {
  if (!scanModule) {
    // Deferred so react-scan's fiber instrumentation costs nothing until an
    // agent explicitly asks for render tracking.
    scanModule = (await import("react-scan")) as unknown as ScanModule
  }
  renderStats.clear()
  tracking = true
  trackingStartedAt = Date.now()
  scanModule.scan({
    enabled: true,
    showToolbar: options?.showToolbar === true,
    log: false,
    onRender: (_fiber: unknown, renders: ReadonlyArray<Record<string, unknown>>) => {
      if (!tracking) return
      for (const render of renders) {
        const name =
          typeof render.componentName === "string"
            ? render.componentName
            : typeof render.name === "string"
              ? render.name
              : "(anonymous)"
        const time = typeof render.time === "number" ? render.time : 0
        const unnecessary = render.unnecessary === true || render.didCommit === false
        recordRender(name, time, unnecessary)
      }
    }
  })
  return JSON.stringify({ ok: true })
}

const rendersStop = (): string => {
  tracking = false
  scanModule?.setOptions({ enabled: false, showToolbar: false })
  return JSON.stringify({ ok: true })
}

const rendersReport = (): string => {
  const components = [...renderStats.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 100)
    .map((stat) => ({ ...stat, totalTimeMs: Math.round(stat.totalTimeMs * 10) / 10 }))
  const report: RendersReport = { tracking, startedAt: trackingStartedAt, components }
  return JSON.stringify(report)
}

const snapshot = (): {
  actors: number
  queryCache: number
  xterm: number
  longTasks: number
  loopLagP95: number
} => ({
  actors: __debugActorCount(),
  queryCache: queryClient.getQueryCache().getAll().length,
  xterm: document.querySelectorAll(".xterm").length,
  longTasks: longTaskCount,
  loopLagP95: loopLagP95()
})

declare global {
  interface Window {
    __jinglerPerf?: {
      snapshot: typeof snapshot
      renders: {
        start: (options?: { showToolbar?: boolean }) => Promise<string>
        stop: () => string
        report: () => string
      }
    }
  }
}

window.__jinglerPerf = {
  snapshot,
  renders: { start: rendersStart, stop: rendersStop, report: rendersReport }
}
