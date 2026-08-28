/**
 * The heavy tier of the dev-mode performance monitor: heap snapshots, CPU
 * profiles, allocation-site sampling, and the three-snapshot leak protocol.
 * Everything here is on-demand only (driven by perf-api.ts requests) — none
 * of it runs during passive sampling.
 *
 * Electron-free by construction (the `RendererCdp` session is injected as a
 * narrow interface) so the logic stays unit-testable without an Electron
 * process.
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The slice of RendererCdp these operations need (kept narrow for tests). */
export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | null>
  raw(): {
    debugger: {
      on(event: "message", listener: (event: unknown, method: string, params: { chunk?: string }) => void): void
      removeListener(
        event: "message",
        listener: (event: unknown, method: string, params: { chunk?: string }) => void
      ): void
    }
  } | null
}

/**
 * Stream a heap snapshot to `file`. GCs first so two snapshots differ by
 * retained objects, not by collectible garbage — without this, comparing
 * snapshots mostly diffs GC timing.
 */
export const takeHeapSnapshot = async (cdp: CdpSession, file: string): Promise<{ path: string }> => {
  const wc = cdp.raw()
  if (!wc) throw new Error("renderer CDP unavailable (DevTools attached, or no live window)")
  await cdp.send("HeapProfiler.enable")
  await cdp.send("HeapProfiler.collectGarbage")
  const out = createWriteStream(file)
  const onChunk = (_event: unknown, method: string, params: { chunk?: string }): void => {
    if (method === "HeapProfiler.addHeapSnapshotChunk" && params.chunk !== undefined) {
      out.write(params.chunk)
    }
  }
  wc.debugger.on("message", onChunk)
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: true
    })
  } finally {
    wc.debugger.removeListener("message", onChunk)
    await new Promise<void>((resolve) => out.end(resolve))
  }
  return { path: file }
}

export const cpuProfileStart = async (cdp: CdpSession): Promise<{ ok: true }> => {
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
  await cdp.send("Profiler.start")
  return { ok: true }
}

export const cpuProfileStop = async (cdp: CdpSession, file: string): Promise<{ path: string }> => {
  const result = await cdp.send<{ profile: unknown }>("Profiler.stop")
  if (!result) throw new Error("Profiler.stop returned nothing — was a profile started?")
  writeFileSync(file, JSON.stringify(result.profile))
  return { path: file }
}

export const allocSamplingStart = async (cdp: CdpSession): Promise<{ ok: true }> => {
  await cdp.send("HeapProfiler.enable")
  // 64KiB sampling interval: coarse enough to be near-free, fine enough that
  // any allocation site leaking megabytes per minute shows up with a stack.
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 65_536 })
  return { ok: true }
}

export const allocSamplingStop = async (cdp: CdpSession, file: string): Promise<{ path: string }> => {
  const result = await cdp.send<{ profile: unknown }>("HeapProfiler.stopSampling")
  if (!result) throw new Error("HeapProfiler.stopSampling returned nothing — was sampling started?")
  writeFileSync(file, JSON.stringify(result.profile))
  return { path: file }
}

export interface LeakCheckOptions {
  /** How long the agent has to reproduce the leak between baseline and target. */
  readonly warmupMs?: number
  /** Settle time before the final snapshot (lets async work finish + GC). */
  readonly settleMs?: number
}

export interface LeakCheckResult {
  readonly workdir: string
  readonly snapshots: { baseline: string; target: string; final: string }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * memlab's three-snapshot protocol: baseline → (reproduce the suspected leak)
 * → target → (settle; anything still alive is genuinely retained) → final.
 * Objects allocated after baseline and still present in final are leak
 * candidates. Files land in memlab's expected `data/cur` layout with a
 * snap-seq manifest, so `memlab find-leaks --work-dir` and the
 * `@memlab/heap-analysis` CLI consume the directory as-is.
 */
export const runLeakCheck = async (
  cdp: CdpSession,
  root: string,
  options: LeakCheckOptions
): Promise<LeakCheckResult> => {
  const warmupMs = Math.min(options.warmupMs ?? 30_000, 300_000)
  const settleMs = Math.min(options.settleMs ?? 10_000, 60_000)
  const workdir = join(root, `leak-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  const dataDir = join(workdir, "data", "cur")
  mkdirSync(dataDir, { recursive: true })

  const baseline = join(dataDir, "s1.heapsnapshot")
  const target = join(dataDir, "s2.heapsnapshot")
  const final = join(dataDir, "s3.heapsnapshot")

  await takeHeapSnapshot(cdp, baseline)
  await sleep(warmupMs)
  await takeHeapSnapshot(cdp, target)
  await sleep(settleMs)
  await takeHeapSnapshot(cdp, final)

  writeFileSync(
    join(dataDir, "snap-seq.json"),
    JSON.stringify(
      [
        { name: "page-load", snapshot: "s1.heapsnapshot", type: "baseline", idx: 1 },
        { name: "action-on-page", snapshot: "s2.heapsnapshot", type: "target", idx: 2 },
        { name: "revert", snapshot: "s3.heapsnapshot", type: "final", idx: 3 }
      ],
      null,
      2
    )
  )
  return { workdir, snapshots: { baseline, target, final } }
}
