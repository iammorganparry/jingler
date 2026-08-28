/**
 * Leak-trend detection over perf-monitor samples (pure — no I/O, unit-tested
 * in trend.test.ts; consumed by scripts/perf/perf.mjs).
 *
 * A leak is growth that survives garbage collection, so the detector must not
 * fire on the normal GC sawtooth. Three gates, all required per signal:
 * least-squares slope > 0, an r-squared floor (growth explains the variance,
 * not noise), and a monotonicity floor (most consecutive steps non-decreasing
 * — a sawtooth rises and falls, a leak ratchets).
 *
 * The verdict classification encodes the diagnostic signatures learned from
 * live-debugging this app's real leaks:
 * - embedderHeap rising while jsHeap is flat → Blink/DOM-side leak (detached
 *   nodes, listeners, style churn) — the 19GB scroll-loop leak's signature.
 * - documents rising in a one-window app → detached documents.
 * - jsEventListeners ratcheting → listener leak.
 * - process RSS rising while jsHeap is flat → native churn outside V8.
 * - actors rising past the eviction cap → conversation-registry eviction
 *   stopped working (historically a multi-GB leak).
 */

/** Least-squares fit of ys against sample index. */
export const linearRegression = (ys) => {
  const n = ys.length
  const meanX = (n - 1) / 2
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let ssxy = 0
  let ssxx = 0
  let ssyy = 0
  for (let i = 0; i < n; i++) {
    ssxy += (i - meanX) * (ys[i] - meanY)
    ssxx += (i - meanX) ** 2
    ssyy += (ys[i] - meanY) ** 2
  }
  const slope = ssxx === 0 ? 0 : ssxy / ssxx
  const r2 = ssyy === 0 ? 0 : (ssxy * ssxy) / (ssxx * ssyy)
  return { slope, r2 }
}

const fractionNonDecreasing = (ys) => {
  if (ys.length < 2) return 1
  let ok = 0
  for (let i = 1; i < ys.length; i++) if (ys[i] >= ys[i - 1]) ok++
  return ok / (ys.length - 1)
}

const SIGNALS = [
  ["mainRss", (s) => s.main?.rss],
  ["jsHeapUsed", (s) => s.renderer?.usedSize],
  ["embedderHeap", (s) => s.renderer?.embedderHeapUsedSize],
  ["jsEventListeners", (s) => s.renderer?.jsEventListeners],
  ["documents", (s) => s.renderer?.documents],
  ["domNodes", (s) => s.renderer?.nodes],
  ["actors", (s) => s.app?.actors],
  ["queryCache", (s) => s.app?.queryCache],
  [
    "rendererWorkingSet",
    (s) => s.processes?.find((p) => p.type === "Tab")?.workingSetKb
  ]
]

const CLASSIFICATIONS = [
  {
    verdict: "blink-dom-leak",
    detail:
      "Blink embedder heap is growing while the JS heap is comparatively flat — DOM-side retention (detached nodes, listeners, style churn).",
    matches: (grown) => grown.has("embedderHeap") && !grown.has("jsHeapUsed")
  },
  {
    verdict: "detached-documents",
    detail: "Document count is climbing in a single-window app — detached documents are being retained.",
    matches: (grown) => grown.has("documents")
  },
  {
    verdict: "listener-leak",
    detail: "JS event listener count ratchets upward — listeners are registered and never removed.",
    matches: (grown) => grown.has("jsEventListeners")
  },
  {
    verdict: "actor-eviction-failure",
    detail:
      "Live conversation-actor count keeps growing — registry eviction has stopped working (historically a multi-GB leak).",
    matches: (grown) => grown.has("actors")
  },
  {
    verdict: "js-heap-leak",
    detail: "The V8 JS heap itself is growing — objects retained by JS references.",
    matches: (grown) => grown.has("jsHeapUsed")
  },
  {
    verdict: "native-churn",
    detail:
      "Process memory is growing while the JS heap is flat — native allocations outside V8 (buffers, compositor, IPC).",
    matches: (grown) =>
      (grown.has("mainRss") || grown.has("rendererWorkingSet")) && !grown.has("jsHeapUsed")
  }
]

/**
 * @param samples ordered oldest→newest PerfSample objects
 * @returns { verdict, detail, signals } — verdict is "insufficient-data",
 *          "stable", or the first matching classification above.
 */
export const detectTrends = (samples, { window = 30, minSamples = 12 } = {}) => {
  const recent = samples.slice(-window)
  if (recent.length < minSamples) {
    return { verdict: "insufficient-data", detail: `need ${minSamples} samples, have ${recent.length}`, signals: [] }
  }
  const spanMs = recent[recent.length - 1].t - recent[0].t
  const perSampleToPerMin = spanMs > 0 ? 60_000 / (spanMs / (recent.length - 1)) : 0

  const signals = []
  const grown = new Set()
  for (const [name, get] of SIGNALS) {
    const ys = recent.map(get).filter((v) => typeof v === "number" && Number.isFinite(v))
    if (ys.length < minSamples) continue
    const { slope, r2 } = linearRegression(ys)
    const monotone = fractionNonDecreasing(ys)
    // Relative floor: a "rising" flat line (slope epsilon on a 100MB base)
    // must not fire. Growth must be at least 0.5% of the mean per window.
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length
    const totalGrowth = slope * (ys.length - 1)
    const material = mean === 0 ? totalGrowth > 0 : totalGrowth / mean >= 0.005
    if (slope > 0 && material && monotone >= 0.85 && r2 >= 0.6) {
      grown.add(name)
      signals.push({
        signal: name,
        slopePerMin: slope * perSampleToPerMin,
        r2: Math.round(r2 * 100) / 100,
        first: ys[0],
        last: ys[ys.length - 1]
      })
    }
  }

  if (signals.length === 0) return { verdict: "stable", detail: "no signal shows sustained growth", signals }
  const match = CLASSIFICATIONS.find((c) => c.matches(grown))
  return {
    verdict: match?.verdict ?? "unclassified-growth",
    detail: match?.detail ?? "sustained growth detected but it fits no known signature",
    signals
  }
}
