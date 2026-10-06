import { routineRunActive, type Routine, type RoutineRun } from "@jingler/core"
import type { RoutineStore } from "@jingler/cli-adapters/routine-store"

import { RoutinePreparationPendingError } from "./routine-execution.js"

class RoutineRequestError extends Error {}
const teardownFailure = /teardown|timed out/i
export interface RoutineClock {
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}
export const desktopRoutineClock: RoutineClock = {
  now: Date.now,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
}
export interface RoutineExecution {
  execute(routine: Routine, run: RoutineRun, signal: AbortSignal, current: () => Promise<boolean>, link: () => Promise<void>): Promise<{ status: "succeeded" | "failed" | "needs-attention"; message: string }>
  sessionExists(id: string): Promise<boolean>
}

/** Desktop-only, one next-due timer. The durable cursor, not this timer, owns time. */
export class RoutineScheduler {
  #timer: unknown
  #active: { run: RoutineRun; generation: number; controller: AbortController; deadlineTimer: unknown; pending?: Promise<unknown>; done: Promise<void> } | undefined
  #queue = Promise.resolve()
  #stopped = true
  #suspended = false
  #generation = 0
  error: string | null = null
  constructor(readonly store: RoutineStore, readonly execution: RoutineExecution, readonly clock: RoutineClock = desktopRoutineClock, readonly elapsedClock: Pick<RoutineClock, "setTimer" | "clearTimer"> = desktopRoutineClock) {}
  get running() { return !this.#stopped }
  get activityUnresolved() { return this.#active?.pending !== undefined }
  async start() {
    if (this.error) throw new Error(`Restart the desktop to recover the routine scheduler: ${this.error}`)
    if (!this.#stopped) return
    const generation = ++this.#generation
    await this.store.reconcile(id => this.execution.sessionExists(id), this.clock.now())
    if (generation !== this.#generation) return
    this.#stopped = false
    await this.wake()
  }
  #serial(operation: () => Promise<void>) {
    const next = this.#queue.then(operation)
    this.#queue = next.catch(error => {
      if (error instanceof RoutineRequestError) return
      this.error = error instanceof Error ? error.message : "Routine persistence failed"
      this.#stopped = true
      this.clock.clearTimer(this.#timer)
      this.#active?.controller.abort(new Error("Routine persistence failed"))
    })
    return next
  }
  invalidatePending() { this.#generation++ }
  async refresh() { await this.#serial(() => this.#arm()) }
  suspend() { this.#generation++; this.#suspended = true; this.clock.clearTimer(this.#timer) }
  async wake() { this.#suspended = false; await this.#serial(() => this.#tick(true)) }
  async runNow(id: string) {
    let result: RoutineRun | undefined
    await this.#serial(async () => {
      if (this.#stopped || this.#suspended) throw new Error(this.error ?? "Desktop scheduler is unavailable")
      const generation = this.#generation
      const claimed = await this.store.claim(id, "manual", this.clock.now())
      if (!claimed) throw new RoutineRequestError("Routine no longer exists")
      result = claimed.run
      if (routineRunActive(claimed.run)) {
        if (this.#unavailable(generation)) await this.store.finish(claimed.run.id, "interrupted", "Desktop stopped before dispatch", this.clock.now())
        else this.#launch(claimed.routine, claimed.run)
      }
      await this.#arm()
    })
    return result!
  }
  async cancelRoutine(id: string) {
    if (this.#active?.run.routineId === id) await this.cancel(this.#active.run.id)
  }
  async cancel(runId: string) {
    const active = this.#active
    if (active?.run.id === runId) {
      active.controller.abort(new Error("Cancelled by operator"))
      await active.done
    } else {
      await this.store.finish(runId, "cancelled", "Cancelled before launch", this.clock.now())
    }
    await this.refresh()
  }
  async stop() {
    this.#generation++
    this.#stopped = true
    this.clock.clearTimer(this.#timer)
    const active = this.#active
    active?.controller.abort(new Error("Desktop is quitting"))
    await this.#queue
    await active?.done
  }
  #unavailable(generation = this.#generation) { return generation !== this.#generation || this.#stopped || this.#suspended }
  async #dispatch(routine: Routine, run: RoutineRun, generation: number) {
    if (!routineRunActive(run)) return
    if (this.#unavailable(generation)) await this.store.finish(run.id, "interrupted", "Desktop stopped before dispatch", this.clock.now())
    else this.#launch(routine, run)
  }
  async #current(run: RoutineRun, signal: AbortSignal) {
    const generation = this.#active?.run.id === run.id ? this.#active.generation : this.#generation
    if (signal.aborted || this.#unavailable(generation)) return false
    return await this.store.isCurrent(run) && !signal.aborted && !this.#unavailable(generation)
  }
  async #tick(missed: boolean) {
    if (this.#stopped || this.#suspended) return
    const generation = this.#generation
    const document = await this.store.read()
    if (this.#unavailable(generation)) return
    for (const routine of document.routines.filter(item => item.enabled && item.nextAt !== null && item.nextAt <= this.clock.now()).sort((a, b) => a.nextAt! - b.nextAt!)) {
      if (this.#unavailable(generation)) break
      const claim = await this.store.claim(routine.id, "scheduled", this.clock.now(), missed)
      if (claim) await this.#dispatch(claim.routine, claim.run, generation)
    }
    await this.#arm()
  }
  #launch(routine: Routine, run: RoutineRun) {
    const controller = new AbortController()
    const active = { run, generation: this.#generation, controller, deadlineTimer: this.elapsedClock.setTimer(() => controller.abort(new Error("Maximum duration reached")), routine.maxDurationMs), pending: undefined as Promise<unknown> | undefined, done: Promise.resolve() }
    this.#active = active
    controller.signal.addEventListener("abort", () => this.elapsedClock.clearTimer(active.deadlineTimer), { once: true })
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: completion and cancellation share one durable history boundary.
    active.done = (async () => {
      try {
        if (!await this.#current(run, controller.signal)) {
          await this.store.finish(run.id, "cancelled", "Routine changed before launch", this.clock.now())
          return
        }
        const result = await this.execution.execute(routine, run, controller.signal, () => this.#current(run, controller.signal), () => this.store.link(run, this.clock.now()))
        await this.store.finish(run.id, controller.signal.aborted ? "cancelled" : result.status, controller.signal.aborted ? String(controller.signal.reason?.message ?? "Cancelled") : result.message, this.clock.now())
      } catch (error) {
        if (error instanceof RoutinePreparationPendingError) {
          active.pending = error.pending
          void error.pending.catch(() => {}).finally(() => { if (this.#active === active) this.#active = undefined })
        }
        if (error instanceof Error && teardownFailure.test(error.message)) {
          this.error = error.message
          this.#stopped = true
          this.clock.clearTimer(this.#timer)
        }
        await this.store.finish(run.id, controller.signal.aborted && !(error instanceof Error && teardownFailure.test(error.message)) ? "cancelled" : "failed", error instanceof Error ? error.message : "Routine execution failed", this.clock.now())
      } finally {
        this.elapsedClock.clearTimer(active.deadlineTimer)
        if (this.#active === active && !active.pending) this.#active = undefined
      }
    })().then(() => this.refresh()).catch(error => {
      this.error = `Routine history could not be saved: ${String(error)}`
      this.#stopped = true
      this.clock.clearTimer(this.#timer)
    })
  }
  async #arm() {
    this.clock.clearTimer(this.#timer)
    if (this.#stopped || this.#suspended) return
    const generation = this.#generation
    const document = await this.store.read()
    if (this.#unavailable(generation)) return
    const next = Math.min(...document.routines.filter(item => item.enabled && item.nextAt !== null).map(item => item.nextAt!))
    if (!Number.isFinite(next)) return
    // Node timers overflow beyond 2^31-1 ms. Re-read durable time at each chunk.
    this.#timer = this.clock.setTimer(() => { void this.#serial(() => this.#tick(false)).catch(() => {}) }, Math.min(2147483647, Math.max(1, next - this.clock.now())))
  }
}
