import { describe, expect, it } from "vitest"
// @ts-expect-error — plain .mjs module shared with the CLI, no type declarations.
import { detectTrends, linearRegression } from "./trend.mjs"

interface SampleShape {
  t: number
  main: { rss: number; heapUsed: number; external: number; arrayBuffers: number }
  processes: Array<{ type: string; pid: number; workingSetKb: number; cpuPercent: number }>
  renderer?: {
    usedSize: number
    embedderHeapUsedSize: number
    backingStorageSize: number
    documents: number
    nodes: number
    jsEventListeners: number
  }
  app?: { actors: number; queryCache: number; xterm: number; longTasks: number; loopLagP95: number }
}

/** Build n samples 20s apart, with per-signal generators over the index. */
const samples = (
  n: number,
  gen: (i: number) => Partial<{
    rss: number
    jsHeap: number
    embedder: number
    listeners: number
    documents: number
    actors: number
  }>
): SampleShape[] =>
  Array.from({ length: n }, (_, i) => {
    const g = gen(i)
    return {
      t: 1_000_000 + i * 20_000,
      main: { rss: g.rss ?? 300e6, heapUsed: 80e6, external: 10e6, arrayBuffers: 1e6 },
      processes: [{ type: "Tab", pid: 42, workingSetKb: (g.rss ?? 300e6) / 1024, cpuPercent: 5 }],
      renderer: {
        usedSize: g.jsHeap ?? 150e6,
        embedderHeapUsedSize: g.embedder ?? 60e6,
        backingStorageSize: 30e6,
        documents: g.documents ?? 7,
        nodes: 12_000,
        jsEventListeners: g.listeners ?? 4000
      },
      app: { actors: g.actors ?? 4, queryCache: 20, xterm: 1, longTasks: 3, loopLagP95: 8 }
    }
  })

describe("linearRegression", () => {
  it("finds the slope of a clean line", () => {
    const { slope, r2 } = linearRegression([0, 2, 4, 6, 8])
    expect(slope).toBeCloseTo(2)
    expect(r2).toBeCloseTo(1)
  })

  it("reports r2 near zero for noise around a flat mean", () => {
    const { r2 } = linearRegression([5, 9, 4, 8, 5, 9, 4, 8])
    expect(r2).toBeLessThan(0.2)
  })
})

describe("detectTrends", () => {
  it("needs a minimum number of samples", () => {
    const result = detectTrends(samples(5, () => ({})))
    expect(result.verdict).toBe("insufficient-data")
  })

  it("stays stable on flat data", () => {
    const result = detectTrends(samples(30, () => ({})))
    expect(result.verdict).toBe("stable")
    expect(result.signals).toHaveLength(0)
  })

  it("does not fire on a GC sawtooth", () => {
    // jsHeap oscillates 150→450→150MB — big swings, no ratchet.
    const result = detectTrends(samples(30, (i) => ({ jsHeap: 150e6 + (i % 5) * 75e6 })))
    expect(result.verdict).toBe("stable")
  })

  it("flags a listener leak", () => {
    const result = detectTrends(samples(30, (i) => ({ listeners: 4000 + i * 500 })))
    expect(result.verdict).toBe("listener-leak")
    expect(result.signals.map((s: { signal: string }) => s.signal)).toContain("jsEventListeners")
  })

  it("classifies embedder growth with flat jsHeap as a Blink/DOM leak", () => {
    const result = detectTrends(samples(30, (i) => ({ embedder: 60e6 + i * 20e6 })))
    expect(result.verdict).toBe("blink-dom-leak")
  })

  it("classifies rss growth with flat jsHeap as native churn", () => {
    const result = detectTrends(samples(30, (i) => ({ rss: 300e6 + i * 30e6 })))
    expect(result.verdict).toBe("native-churn")
  })

  it("flags actor-registry eviction failure", () => {
    const result = detectTrends(samples(30, (i) => ({ actors: 4 + i })))
    expect(result.verdict).toBe("actor-eviction-failure")
  })

  it("ignores immaterial drift on a large base", () => {
    // +1KB per sample on a 300MB base: monotone and perfectly linear, but
    // ~0.01% total — must not be called a leak.
    const result = detectTrends(samples(30, (i) => ({ rss: 300e6 + i * 1024 })))
    expect(result.verdict).toBe("stable")
  })

  it("works on samples missing renderer counters (degraded CDP)", () => {
    const degraded = samples(30, (i) => ({ rss: 300e6 + i * 30e6 })).map(
      ({ renderer: _renderer, ...rest }) => rest
    )
    const result = detectTrends(degraded)
    expect(result.verdict).toBe("native-churn")
  })
})
