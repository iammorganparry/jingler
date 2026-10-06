import type { Routine, RoutineRun, Session } from "@jingler/core"
import { Effect, Runtime } from "effect"
import type { RoutineExecution } from "./routine-scheduler.js"

export class RoutinePreparationPendingError extends Error {
  constructor(readonly pending: Promise<unknown>) {
    super("Routine preparation teardown timed out; activity remains unresolved. Restart the desktop before admitting another routine.")
  }
}

/** Mutation promises cannot prove cancellation. Retain ownership through commit and
 * association even after an interrupt; the caller bounds its wait, not the operation. */
export function runOwnedRoutineEffect<A, E, R>(runtime: Runtime.Runtime<R>, effect: Effect.Effect<A, E, R>, signal: AbortSignal, committed: (value: A) => Promise<unknown> = async () => {}) {
  return Runtime.runPromise(runtime)(effect.pipe(Effect.tap(value => Effect.promise(() => committed(value))), Effect.uninterruptible), { signal })
}

const preparation = <A>(operation: Promise<A>, signal: AbortSignal): Promise<A> => new Promise((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => { timer ??= setTimeout(() => reject(new RoutinePreparationPendingError(operation)), 10_000) }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  void operation.then(resolve, reject).finally(() => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  })
})

export interface RoutineExecutionPorts {
  validate(routine: Routine, signal: AbortSignal): Promise<unknown>
  create(routine: Routine, run: RoutineRun, signal: AbortSignal, committed: (session: Session) => Promise<void>): Promise<Session>
  setMode(id: string, signal: AbortSignal): Promise<unknown>
  prompt(session: Session, routine: Routine, signal: AbortSignal): ReturnType<RoutineExecution["execute"]>
}
/** All durable claims enter the same production creation, mode and turn gates. */
export const routineExecution = (ports: RoutineExecutionPorts): RoutineExecution["execute"] => async (routine, run, signal, current, link) => {
  const check = async () => {
    if (signal.aborted || !await current()) throw new Error("Routine changed or cancelled before dispatch")
    await preparation(ports.validate(routine, signal), signal)
    if (signal.aborted || !await current()) throw new Error("Routine changed or cancelled during validation")
  }
  let association: Promise<void> | undefined
  const associate = (session: Session) => {
    if (session.id !== run.requestedSessionId || session.routineOccurrence?.routineId !== run.routineId || session.routineOccurrence.runId !== run.id) throw new Error("Created session does not match its reserved occurrence")
    association ??= link()
    return association
  }
  await check()
  // Associate on actual creation, including completion after the bounded cancel wait.
  const session = await preparation(ports.create(routine, run, signal, associate).then(async session => { await associate(session); return session }), signal)
  await check()
  if (!session.checkpointSafeMode || session.checkpointExecutionHistory !== "clean" || session.workspaceLifecycle?.status !== "setup-skipped") throw new Error("Safe creation did not persist clean history and skipped setup")
  await preparation(ports.setMode(session.id, signal), signal)
  await check()
  return ports.prompt(session, routine, signal)
}
