/**
 * Memory-infra dump — the allocator-level view the CDP counters cannot give.
 *
 * `Runtime.getHeapUsage` and `Memory.getDOMCounters` see the JS heap, the
 * Oilpan heap and DOM object counts, and nothing else. The 13GB app-renderer
 * this was written against had a flat JS heap, flat node/listener counts and
 * a ratcheting Oilpan floor — and 10GB of it sat in PartitionAlloc slot spans
 * (macOS VM tag 253) that no CDP domain reports. Chromium's own memory-infra
 * tracing category does: one `detailed` dump per process lists every
 * memory allocator (`partition_alloc/partitions/*`, `blink_gc`, `v8/*` per
 * isolate — workers included — `skia`, `web_cache`, `font_caches`, `malloc`,
 * `discardable`) and the `blink_objects/*` instance counts (Resource,
 * Document, Frame, LayoutObject, …) that name what is holding it.
 *
 * Captured through `contentTracing`, which does NOT use the renderer's
 * debugger slot — so it works with DevTools open, and while a wedged CDP
 * command still holds the monitor's exclusive-op lock. The raw trace is
 * written to disk and summarized by `scripts/perf/memory-infra.mjs`; main
 * never parses it.
 */
import { contentTracing } from "electron"

export interface MemoryDumpOptions {
  /** How many periodic detailed dumps to collect before stopping (≥1). */
  readonly dumps?: number
  /** Spacing between dumps. */
  readonly intervalMs?: number
}

const DEFAULT_DUMPS = 1
const DEFAULT_INTERVAL_MS = 2_000
const MAX_DUMPS = 10
/** Grace after the last expected dump so every process has flushed it. */
const FLUSH_GRACE_MS = 1_500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Bounded, integer-clamped dump plan. Exported for tests. */
export const memoryDumpPlan = (
  options: MemoryDumpOptions
): { readonly dumps: number; readonly intervalMs: number; readonly waitMs: number } => {
  const dumps = Math.min(MAX_DUMPS, Math.max(1, Math.trunc(options.dumps ?? DEFAULT_DUMPS) || DEFAULT_DUMPS))
  const intervalMs = Math.min(
    30_000,
    Math.max(500, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS)
  )
  return { dumps, intervalMs, waitMs: dumps * intervalMs + FLUSH_GRACE_MS }
}

export const captureMemoryDump = async (
  file: string,
  options: MemoryDumpOptions = {}
): Promise<{ path: string; dumps: number }> => {
  const plan = memoryDumpPlan(options)
  await contentTracing.startRecording({
    included_categories: ["disabled-by-default-memory-infra"],
    excluded_categories: ["*"],
    memory_dump_config: {
      allowed_dump_modes: ["detailed"],
      triggers: [
        {
          // Both spellings: Chromium's TraceConfig parser accepts the legacy
          // `periodic_interval_ms` and the current `type`/`min_time_between_dumps_ms`.
          type: "periodic_interval",
          mode: "detailed",
          min_time_between_dumps_ms: plan.intervalMs,
          periodic_interval_ms: plan.intervalMs
        }
      ]
    }
  })
  try {
    await sleep(plan.waitMs)
  } finally {
    await contentTracing.stopRecording(file)
  }
  return { path: file, dumps: plan.dumps }
}
