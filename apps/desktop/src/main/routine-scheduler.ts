import { routineRunActive, type Routine, type RoutineRun } from "@jingler/core"
import type { RoutineStore } from "@jingler/cli-adapters/routine-store"

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
  #active: { run: RoutineRun; controller: AbortController; deadline: number; done: Promise<void> } | undefined
  #queue = Promise.resolve()
  #stopped = true
  #suspended = false
  error: string | null = null
  constructor(readonly store: RoutineStore, readonly execution: RoutineExecution, readonly clock: RoutineClock = desktopRoutineClock) {}
  async start() {
    await this.store.reconcile(id => this.execution.sessionExists(id), this.clock.now())
    this.#stopped = false
    await this.wake()
  }
  #serial(operation: () => Promise<void>) {
    const next = this.#queue.then(operation)
    this.#queue = next.catch(error => {
      this.error = error instanceof Error ? error.message : "Routine persistence failed"
      this.#stopped = true
      this.clock.clearTimer(this.#timer)
      this.#active?.controller.abort(new Error("Routine persistence failed"))
    })
    return next
  }
  async refresh() { await this.#serial(() => this.#arm()) }
  suspend() { this.#suspended = true; this.clock.clearTimer(this.#timer) }
  async wake() { this.#suspended = false; await this.#serial(() => this.#tick(true)) }
  async runNow(id: string) {
    let result: RoutineRun | undefined
    await this.#serial(async () => {
      if (this.#stopped) throw new Error(this.error ?? "Desktop scheduler is unavailable")
      const claimed = await this.store.claim(id, "manual", this.clock.now())
      if (!claimed) throw new Error("Routine no longer exists")
      result = claimed.run
      if (routineRunActive(claimed.run)) this.#launch(claimed.routine, claimed.run)
      await this.#arm()
    })
    return result!
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
    this.#stopped = true
    this.clock.clearTimer(this.#timer)
    const active = this.#active
    active?.controller.abort(new Error("Desktop is quitting"))
    await active?.done
  }
  async #tick(missed: boolean) {
    if (this.#stopped || this.#suspended) return
    if (this.#active && this.clock.now() >= this.#active.deadline) this.#active.controller.abort(new Error("Maximum duration reached"))
    const document = await this.store.read()
    for (const routine of document.routines.filter(item => item.enabled && item.nextAt !== null && item.nextAt <= this.clock.now()).sort((a, b) => a.nextAt! - b.nextAt!)) {
      const claim = await this.store.claim(routine.id, "scheduled", this.clock.now(), missed)
      if (claim && routineRunActive(claim.run)) this.#launch(claim.routine, claim.run)
    }
    await this.#arm()
  }
  #launch(routine: Routine, run: RoutineRun) {
    const controller = new AbortController()
    const active = { run, controller, deadline: this.clock.now() + routine.maxDurationMs, done: Promise.resolve() }
    this.#active = active
    active.done = (async () => {
      try {
        if (!await this.store.isCurrent(run) || controller.signal.aborted) {
          await this.store.finish(run.id, "cancelled", "Routine changed before launch", this.clock.now())
          return
        }
        const result = await this.execution.execute(routine, run, controller.signal, () => this.store.isCurrent(run), () => this.store.link(run, this.clock.now()))
        await this.store.finish(run.id, controller.signal.aborted ? "cancelled" : result.status, controller.signal.aborted ? String(controller.signal.reason?.message ?? "Cancelled") : result.message, this.clock.now())
      } catch (error) {
        await this.store.finish(run.id, controller.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : "Routine execution failed", this.clock.now())
      } finally {
        if (this.#active === active) this.#active = undefined
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
    const document = await this.store.read()
    const next = Math.min(...document.routines.filter(item => item.enabled && item.nextAt !== null).map(item => item.nextAt!), this.#active?.controller.signal.aborted ? Infinity : this.#active?.deadline ?? Infinity)
    if (!Number.isFinite(next)) return
    // Node timers overflow beyond 2^31-1 ms. Re-read durable time at each chunk.
    this.#timer = this.clock.setTimer(() => { void this.#serial(() => this.#tick(false)).catch(() => {}) }, Math.min(2147483647, Math.max(1, next - this.clock.now())))
  }
}
