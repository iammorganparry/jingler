/**
 * Dev-mode performance monitor — the passive tier.
 *
 * Samples cheap process + renderer counters every `JINGLER_PERF_INTERVAL_MS`
 * (default 20s) into an in-memory ring buffer and an append-only JSONL file
 * under `~/jingler/diagnostics/perf/`, and serves the agent-facing loopback
 * HTTP API (see perf-api.ts). Heavy operations — heap snapshots, CPU and
 * allocation profiles, the three-snapshot leak protocol — live in
 * perf-snapshots.ts and only run when an agent asks.
 *
 * This module is loaded via dynamic `import()` from the dev-only gate in
 * index.ts (`enablePerfMonitor`), so packaged builds never evaluate it. It is
 * deliberately plain TS with no Effect dependency: the monitor's job is to
 * keep observing when the rest of the app misbehaves, so it must not share a
 * failure domain with the runtime it watches.
 *
 * ## Why CDP through `webContents.debugger`
 *
 * Every renderer metric worth having lives behind the Chrome DevTools
 * Protocol: `Runtime.getHeapUsage` exposes `embedderHeapUsedSize` (the
 * Blink/cppgc heap — DOM-side leaks grow HERE while the JS heap stays flat,
 * exactly the signature of the 19GB scroll-loop leak this tooling was born
 * from), and `Memory.getDOMCounters` exposes documents / nodes / listener
 * counts. `wc.debugger` reaches all of it with no remote-debugging port and
 * no extra process. The debugger slot is exclusive, though — if the developer
 * opens DevTools the attach fails and the sampler degrades to
 * `app.getAppMetrics()` + `process.memoryUsage()` (the `renderer` block goes
 * absent and `/status` reports `cdpAttached: false` so agents know why).
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import { app, webContents, type WebContents } from "electron"
import { jinglerRoot } from "./app-paths.js"
import { startPerfApi, type PerfApiDeps, type PerfSample } from "./perf-api.js"
import { captureMemoryDump } from "./perf-memory-dump.js"
import {
  cpuProfileStart,
  cpuProfileStop,
  allocSamplingStart,
  allocSamplingStop,
  runLeakCheck,
  takeHeapSnapshot
} from "./perf-snapshots.js"

const SAMPLE_INTERVAL_MS = Number(process.env.JINGLER_PERF_INTERVAL_MS ?? 20_000)
/** ~4 hours of history at the default interval. */
const RING_CAPACITY = 720
/**
 * Ceiling on any exclusive operation. A CDP command against a renderer that
 * has been swapped out to disk (`HeapProfiler.stopSampling` on a 13GB
 * process, in the case that motivated this) can simply never answer; without
 * a bound the op held the monitor's exclusive lock for the rest of the dev
 * session and every later heavy request 500'd with "another operation is in
 * flight". The command itself is not cancelled — CDP has no cancel — but the
 * lock is released and the caller learns why.
 */
const EXCLUSIVE_OP_TIMEOUT_MS = Number(process.env.JINGLER_PERF_OP_TIMEOUT_MS ?? 180_000)

export const perfDiagnosticsRoot = (): string => join(jinglerRoot, "diagnostics", "perf")

/**
 * One persistent CDP session against the app window's renderer.
 *
 * The webContents is re-resolved on every use rather than captured: macOS
 * recreates the window on dock-activate, and a monitor pinned to a destroyed
 * webContents would silently stop reporting renderer counters for the rest of
 * the dev session.
 */
export class RendererCdp {
  private wc: WebContents | null = null

  constructor(private readonly preferredId: number) {}

  target(): WebContents | null {
    const preferred = webContents.fromId(this.preferredId)
    if (preferred && !preferred.isDestroyed()) return preferred
    return (
      webContents
        .getAllWebContents()
        .find((w) => !w.isDestroyed() && w.getType() === "window") ?? null
    )
  }

  /** Attach if needed. False when no live target or DevTools owns the slot. */
  ensure(): boolean {
    const wc = this.target()
    if (!wc) {
      this.wc = null
      return false
    }
    if (this.wc === wc && wc.debugger.isAttached()) return true
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3")
      this.wc = wc
      return true
    } catch {
      this.wc = null
      return false
    }
  }

  attached(): boolean {
    return this.wc !== null && !this.wc.isDestroyed() && this.wc.debugger.isAttached()
  }

  /** The live attached webContents, for event listeners (snapshot streaming). */
  raw(): WebContents | null {
    return this.ensure() ? this.wc : null
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | null> {
    if (!this.ensure() || this.wc === null) return null
    try {
      return (await this.wc.debugger.sendCommand(method, params)) as T
    } catch {
      return null
    }
  }

  detach(): void {
    try {
      if (this.wc && !this.wc.isDestroyed() && this.wc.debugger.isAttached()) {
        this.wc.debugger.detach()
      }
    } catch {
      // Detach is best-effort teardown; the process is exiting anyway.
    }
    this.wc = null
  }
}

interface HeapUsage {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize?: number
  readonly backingStorageSize?: number
}

interface DomCounters {
  readonly documents: number
  readonly nodes: number
  readonly jsEventListeners: number
}

/** Best-effort read of the renderer dev hook's app-level metrics. */
const readAppMetrics = async (cdp: RendererCdp): Promise<PerfSample["app"] | undefined> => {
  const result = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: "globalThis.__jinglerPerf ? JSON.stringify(globalThis.__jinglerPerf.snapshot()) : null",
    returnByValue: true
  })
  const raw = result?.result?.value
  if (typeof raw !== "string") return
  try {
    return JSON.parse(raw) as PerfSample["app"]
  } catch {
    // Unparseable hook output — treat as absent.
  }
}

const takeSample = async (cdp: RendererCdp): Promise<PerfSample> => {
  const mem = process.memoryUsage()
  const heap = await cdp.send<HeapUsage>("Runtime.getHeapUsage")
  const dom = await cdp.send<DomCounters>("Memory.getDOMCounters")
  const appMetrics = await readAppMetrics(cdp)
  const target = cdp.target()
  return {
    t: Date.now(),
    ...(target ? { rendererPid: target.getOSProcessId() } : {}),
    main: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers
    },
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      // Electron reports workingSetSize in kilobytes.
      workingSetKb: m.memory.workingSetSize,
      cpuPercent: m.cpu.percentCPUUsage
    })),
    renderer:
      heap && dom
        ? {
            usedSize: heap.usedSize,
            embedderHeapUsedSize: heap.embedderHeapUsedSize ?? 0,
            backingStorageSize: heap.backingStorageSize ?? 0,
            documents: dom.documents,
            nodes: dom.nodes,
            jsEventListeners: dom.jsEventListeners
          }
        : undefined,
    app: appMetrics
  }
}

/** Ask the renderer dev hook to start/stop/report render tracking. */
const rendersOp = async (cdp: RendererCdp, op: string): Promise<unknown> => {
  const result = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    {
      expression: `globalThis.__jinglerPerf ? ${op} : Promise.resolve(JSON.stringify({ error: "renderer perf hook not installed (built renderer or non-dev bundle)" }))`,
      awaitPromise: true,
      returnByValue: true
    }
  )
  const raw = result?.result?.value
  if (typeof raw !== "string") return { error: "renderer did not respond" }
  try {
    return JSON.parse(raw)
  } catch {
    return { error: "unparseable renderer response" }
  }
}

export interface PerfMonitorHandle {
  readonly stop: () => void
}

interface MonitorState {
  readonly cdp: RendererCdp
  readonly ring: PerfSample[]
  readonly root: string
  readonly jsonlPath: string
  readonly activeOps: Set<string>
  readonly sampleOnce: () => Promise<PerfSample>
}

/**
 * Heavy CDP operations are exclusive: two overlapping CPU profiles corrupt
 * each other, and concurrent heap snapshots interleave their chunk streams.
 */
const exclusively = async <T>(
  state: MonitorState,
  op: string,
  run: () => Promise<T>,
  timeoutMs: number = EXCLUSIVE_OP_TIMEOUT_MS
): Promise<T> => {
  if (state.activeOps.size > 0) {
    throw new Error(`another operation is in flight: ${[...state.activeOps].join(", ")}`)
  }
  state.activeOps.add(op)
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${op} timed out after ${Math.round(timeoutMs / 1000)}s — the renderer did not answer (swapped out, or a CDP command that never completes); the lock is released`
          )
        ),
      timeoutMs
    )
    timer.unref()
  })
  try {
    return await Promise.race([run(), deadline])
  } finally {
    clearTimeout(timer)
    state.activeOps.delete(op)
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-")

const buildApiDeps = (state: MonitorState): PerfApiDeps => ({
  status: () => ({
    pid: process.pid,
    webContentsId: state.cdp.target()?.id ?? null,
    cdpAttached: state.cdp.ensure(),
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    samples: state.ring.length,
    jsonlPath: state.jsonlPath,
    activeOps: [...state.activeOps]
  }),
  metrics: () => state.sampleOnce(),
  history: (limit) => state.ring.slice(-limit),
  gc: async () => {
    await state.cdp.send("HeapProfiler.enable")
    await state.cdp.send("HeapProfiler.collectGarbage")
  },
  heapSnapshot: (label) =>
    exclusively(state, "heap-snapshot", () =>
      takeHeapSnapshot(
        state.cdp,
        join(state.root, `${stamp()}${label ? `-${label}` : ""}.heapsnapshot`)
      )
    ),
  cpuProfileStart: () => exclusively(state, "cpu-profile-arm", () => cpuProfileStart(state.cdp)),
  cpuProfileStop: () =>
    exclusively(state, "cpu-profile-collect", () =>
      cpuProfileStop(state.cdp, join(state.root, `${stamp()}.cpuprofile`))
    ),
  allocStart: () => exclusively(state, "alloc-arm", () => allocSamplingStart(state.cdp)),
  allocStop: () =>
    exclusively(state, "alloc-collect", () =>
      allocSamplingStop(state.cdp, join(state.root, `${stamp()}.heapprofile`))
    ),
  rendersStart: (showToolbar) =>
    rendersOp(
      state.cdp,
      `globalThis.__jinglerPerf.renders.start(${JSON.stringify({ showToolbar })})`
    ),
  rendersStop: () => rendersOp(state.cdp, "globalThis.__jinglerPerf.renders.stop()"),
  rendersReport: () => rendersOp(state.cdp, "globalThis.__jinglerPerf.renders.report()"),
  leakCheck: (options) =>
    exclusively(
      state,
      "leak-check",
      () => runLeakCheck(state.cdp, state.root, options),
      // Three snapshots plus the caller's warmup: the default op ceiling would
      // cut a long repro window short.
      Math.max(EXCLUSIVE_OP_TIMEOUT_MS, (options.warmupMs ?? 0) + (options.settleMs ?? 0) + EXCLUSIVE_OP_TIMEOUT_MS)
    ),
  // Tracing does not touch the debugger slot, so it deliberately bypasses
  // `exclusively`: it must still work while a wedged CDP op holds the lock.
  memoryDump: (options) => captureMemoryDump(join(state.root, `${stamp()}.memory-infra.json`), options)
})

export const startPerfMonitor = async (preferredWebContentsId: number): Promise<PerfMonitorHandle> => {
  const root = perfDiagnosticsRoot()
  mkdirSync(root, { recursive: true })

  const cdp = new RendererCdp(preferredWebContentsId)
  const ring: PerfSample[] = []
  const jsonlPath = join(root, "history.jsonl")
  const jsonl: WriteStream = createWriteStream(jsonlPath, { flags: "a" })

  const sampleOnce = async (): Promise<PerfSample> => {
    const sample = await takeSample(cdp)
    ring.push(sample)
    if (ring.length > RING_CAPACITY) ring.shift()
    jsonl.write(`${JSON.stringify(sample)}\n`)
    return sample
  }

  const state: MonitorState = { cdp, ring, root, jsonlPath, activeOps: new Set(), sampleOnce }
  const api = await startPerfApi(root, buildApiDeps(state))

  const timer = setInterval(() => {
    sampleOnce().catch(() => {})
  }, SAMPLE_INTERVAL_MS)
  // A diagnostics timer must never keep the app process alive.
  timer.unref()
  sampleOnce().catch(() => {})

  console.info(
    `[perf-monitor] sampling every ${SAMPLE_INTERVAL_MS}ms; agent API on 127.0.0.1:${api.port} (endpoint file: ${join(root, "endpoint.json")})`
  )

  const stop = (): void => {
    clearInterval(timer)
    api.stop()
    cdp.detach()
    jsonl.end()
  }
  app.on("will-quit", stop)
  return { stop }
}
