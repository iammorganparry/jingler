import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RoutineInput } from "@jingler/core"
import { RoutineStore } from "@jingler/cli-adapters/routine-store"
import { Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { routineExecution } from "./routine-execution.js"
import { RoutineScheduler, type RoutineClock } from "./routine-scheduler.js"
const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect", baseBranch: "main", runtimeId: "pi", endpointId: "test", connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "interval", at: 1000, everyMs: 1000 }, maxDurationMs: 10000 })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
describe("desktop routine clock and dispatch fence", () => {
  let root: string; let store: RoutineStore; let now: number; let timer: (() => void) | undefined; let scheduler: RoutineScheduler
  const execute = vi.fn(async () => ({ status: "succeeded" as const, message: "Done" }))
  const clock: RoutineClock = { now: () => now, setTimer: callback => { timer = callback; return callback }, clearTimer: () => { timer = undefined } }
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "routine-scheduler-")); store = new RoutineStore(join(root, "routines.json")); now = 0; execute.mockClear(); scheduler = new RoutineScheduler(store, { execute, sessionExists: async () => false }, clock) })
  afterEach(async () => { await scheduler.stop(); await rm(root, { recursive: true, force: true }) })
  it("skips startup/sleep missed occurrences and dispatches the next bounded-clock occurrence", async () => {
    await store.save(undefined, input, null, 0); now = 3000; await scheduler.start()
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).routines[0]!.nextAt).toBe(4000)
    scheduler.suspend(); now = 8000; await scheduler.wake()
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).routines[0]!.nextAt).toBe(9000)
    now = 9000; timer!(); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  })
  it("does not launch after stop during a deferred claim", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id; await scheduler.start()
    const entered = deferred<void>(); const release = deferred<void>(); const original = store.claim.bind(store)
    vi.spyOn(store, "claim").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const request = scheduler.runNow(id); await entered.promise; const stopped = scheduler.stop(); release.resolve(); await request; await stopped
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).runs[0]!.status).toBe("interrupted")
  })
  it("does not launch or arm after suspension during deferred read", async () => {
    await store.save(undefined, input, null, 0); await scheduler.start(); now = 1000
    const entered = deferred<void>(); const release = deferred<void>(); const original = store.read.bind(store)
    vi.spyOn(store, "read").mockImplementationOnce(async () => { entered.resolve(); await release.promise; return original() })
    timer!(); await entered.promise; scheduler.suspend(); release.resolve(); await scheduler.refresh()
    expect(execute).not.toHaveBeenCalled(); expect(timer).toBeUndefined()
  })
  it("cancellation waits for owned teardown before releasing the global slot", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const entered = deferred<void>(); const teardown = deferred<void>()
    const execution = vi.fn(async (_routine: import("@jingler/core").Routine, _run: import("@jingler/core").RoutineRun, signal: AbortSignal) => {
      entered.resolve()
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { void teardown.promise.then(resolve) }, { once: true }))
      return { status: "succeeded" as const, message: "Done" }
    })
    scheduler = new RoutineScheduler(store, { execute: execution, sessionExists: async () => false }, clock)
    await scheduler.start(); const run = await scheduler.runNow(id); await entered.promise
    const cancel = scheduler.cancel(run.id)
    expect((await store.read()).runs[0]!.status).toBe("claimed")
    expect((await scheduler.runNow(id)).status).toBe("skipped")
    teardown.resolve(); await cancel
    expect((await store.read()).runs[0]!.status).toBe("cancelled")
  })
  it("claim write failure halts dispatch visibly without launching", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    await scheduler.start()
    vi.spyOn(store.document, "update").mockRejectedValueOnce(new Error("claim write failed"))
    await expect(scheduler.runNow(id)).rejects.toThrow("claim write failed")
    expect(execute).not.toHaveBeenCalled(); expect(scheduler.error).toBe("claim write failed")
    expect((await store.read()).runs).toEqual([])
  })
  it("restart never redispatches a claimed occurrence before or after linking", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const claim = (await store.claim(id, "manual", 0))!
    await store.link(claim.run, 0)
    await scheduler.start()
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).runs[0]!.status).toBe("interrupted")
    expect((await store.read()).runs[0]!.sessionId).toBeNull()
  })

  it("definition invalidation fences a manual claim still awaiting persistence", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id; await scheduler.start()
    const entered = deferred<void>(); const release = deferred<void>(); const original = store.claim.bind(store)
    vi.spyOn(store, "claim").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
    const request = scheduler.runNow(id); await entered.promise; scheduler.invalidatePending(); await store.enable(id, false, 1); release.resolve(); await request
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).runs[0]!.status).toBe("interrupted")
  })
  it("cannot restart in-process after cancellation teardown failure", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    scheduler = new RoutineScheduler(store, { execute: async () => { throw new Error("Routine cancellation teardown timed out") }, sessionExists: async () => false }, clock)
    await scheduler.start(); await scheduler.runNow(id)
    await vi.waitFor(() => expect(scheduler.error).toContain("timed out"))
    await expect(scheduler.start()).rejects.toThrow("Restart the desktop")
    await scheduler.stop()
    expect((await store.read()).runs[0]!.status).toBe("failed")
  })

  it("elapsed maximum duration ignores backwards wall-clock jumps and does not rearm", async () => {
    now = 100_000_000
    const id = (await store.save(undefined, { ...input, schedule: { kind: "once", at: 200_000_000 } }, null, now)).routines[0]!.id
    let deadline: (() => void) | undefined; const clearDeadline = vi.fn()
    const elapsed = { setTimer: vi.fn((callback: () => void, ms: number) => { deadline = callback; expect(ms).toBe(input.maxDurationMs); return callback }), clearTimer: clearDeadline }
    const entered = deferred<void>(); let aborted = false
    scheduler = new RoutineScheduler(store, { sessionExists: async () => false, execute: async (_, __, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve() }, { once: true }))
      return { status: "succeeded", message: "Done" }
    } }, clock, elapsed)
    await scheduler.start(); await scheduler.runNow(id); await entered.promise
    now = 1; await scheduler.refresh(); expect(aborted).toBe(false)
    deadline!(); await vi.waitFor(() => expect(aborted).toBe(true))
    await scheduler.stop(); expect(elapsed.setTimer).toHaveBeenCalledTimes(1); expect(clearDeadline).toHaveBeenCalled()
    expect((await store.read()).runs[0]!.status).toBe("cancelled")
  })
  it("rechecks scheduled wall time after a backwards jump instead of launching a future occurrence", async () => {
    await store.save(undefined, input, null, 0)
    await scheduler.start()
    const due = timer!
    now = -100_000
    due(); await scheduler.refresh()
    expect(execute).not.toHaveBeenCalled(); expect((await store.read()).runs).toEqual([])
    now = 1000
    timer!(); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    await scheduler.stop()
    expect((await store.read()).runs[0]!.occurrenceAt).toBe(1000)
  })
  it("a cancelled run's elapsed callback cannot abort the next run", async () => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const deadlines: (() => void)[] = []
    const signals: AbortSignal[] = []
    scheduler = new RoutineScheduler(store, {
      sessionExists: async () => false,
      execute: async (_, __, signal) => {
        signals.push(signal)
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        return { status: "succeeded", message: "Done" }
      }
    }, clock, { setTimer: callback => { deadlines.push(callback); return callback }, clearTimer: () => {} })
    now = 100
    await scheduler.start()
    const first = await scheduler.runNow(id); await vi.waitFor(() => expect(signals).toHaveLength(1))
    now = 1; await scheduler.cancel(first.id)
    const second = await scheduler.runNow(id); await vi.waitFor(() => expect(signals).toHaveLength(2))
    deadlines[0]!(); expect(signals[1]!.aborted).toBe(false)
    await scheduler.cancel(second.id)
    expect((await store.read()).runs.map(run => run.status)).toEqual(["cancelled", "cancelled"])
  })
  it.each(["validate", "create", "setMode"].flatMap(stage => ["stop", "cancel"].map(action => ({ stage, action }))))("$action during unresolved $stage is bounded but retains activity and blocks admission", async ({ stage, action }) => {
    const id = (await store.save(undefined, input, null, 0)).routines[0]!.id
    const entered = deferred<void>(); const release = deferred<void>(); const prompt = vi.fn()
    const wait = async () => { entered.resolve(); await release.promise }
    const execution = routineExecution({
      validate: async () => { if (stage === "validate") await wait() },
      create: async (_, run) => { if (stage === "create") await wait(); return { id: run.requestedSessionId, routineOccurrence: { routineId: run.routineId, runId: run.id }, checkpointSafeMode: true, checkpointExecutionHistory: "clean", workspaceLifecycle: { status: "setup-skipped" } } as import("@jingler/core").Session },
      setMode: async () => { if (stage === "setMode") await wait() }, prompt
    })
    scheduler = new RoutineScheduler(store, { execute: execution, sessionExists: async () => false }, clock)
    await scheduler.start(); const run = await scheduler.runNow(id); await entered.promise
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const stopped = action === "stop" ? scheduler.stop() : scheduler.cancel(run.id); await vi.advanceTimersByTimeAsync(10_000); await stopped
      expect(scheduler.error).toContain("remains unresolved"); expect(scheduler.activityUnresolved).toBe(true)
      expect((await store.read()).runs[0]!.status).toBe("failed")
      await expect(scheduler.runNow(id)).rejects.toThrow("unresolved")
      await expect(scheduler.start()).rejects.toThrow("Restart the desktop")
      release.resolve(); vi.useRealTimers()
      await vi.waitFor(() => expect(scheduler.activityUnresolved).toBe(false))
      expect(prompt).not.toHaveBeenCalled()
      if (stage !== "validate") expect((await store.read()).runs[0]!.sessionId).toBe(run.requestedSessionId)
    } finally { vi.useRealTimers(); release.resolve() }
  })

})
