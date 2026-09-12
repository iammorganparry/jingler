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

/**
 * Sweep React's dev-only User Timing entries.
 *
 * React 19.2's development build logs every component render and every lane
 * onto the "Components ⚛" / "Scheduler ⚛" DevTools tracks with
 * `performance.measure` (react-dom-client.development.js, `logComponentRender`
 * and friends). User Timing has no buffer limit, and nothing ever consumes the
 * entries, so they accumulate for the life of the page: measured at 452,703
 * retained `PerformanceMeasure` objects (52MB of Oilpan) 28 minutes into a dev
 * session. The Performance panel captures a measure at the moment it is made,
 * so clearing the buffer afterwards costs a recording nothing. Nothing in the
 * app reads marks or measures (grep before adding something that does).
 */
const USER_TIMING_SWEEP_MS = 5_000
if (typeof performance.clearMeasures === "function") {
  window.setInterval(() => {
    performance.clearMeasures()
    performance.clearMarks()
  }, USER_TIMING_SWEEP_MS)
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

/**
 * Running animations, bucketed by "<tag>.<animation-name>" so a sample names
 * WHAT is animating, not just how much. A CSS animation Blink cannot hand to
 * the compositor (SVG children, `filter`/`color`/`background-position`
 * keyframes, inline boxes) recomputes style and paints on the main thread
 * every frame for as long as it runs — measured as 45 fresh `ComputedStyle`
 * objects per frame and 19% `(program)` time in an otherwise idle renderer.
 * `getAnimations()` walks the animation list, not the DOM, so it stays cheap.
 */
const animationBuckets = (): { running: number; top: string[] } => {
  if (typeof document.getAnimations !== "function") return { running: 0, top: [] }
  const counts = new Map<string, number>()
  let running = 0
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running") continue
    running += 1
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
    const tag = target instanceof Element ? target.tagName.toLowerCase() : "?"
    const name =
      animation instanceof CSSAnimation
        ? animation.animationName
        : animation instanceof CSSTransition
          ? `transition:${animation.transitionProperty}`
          : "waapi"
    const key = `${tag}.${name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => `${key}×${count}`)
  return { running, top }
}

const snapshot = (): {
  actors: number
  queryCache: number
  xterm: number
  longTasks: number
  loopLagP95: number
  animations: number
  animationTop: string[]
} => {
  const animations = animationBuckets()
  return {
    actors: __debugActorCount(),
    queryCache: queryClient.getQueryCache().getAll().length,
    xterm: document.querySelectorAll(".xterm").length,
    longTasks: longTaskCount,
    loopLagP95: loopLagP95(),
    animations: animations.running,
    animationTop: animations.top
  }
}

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
