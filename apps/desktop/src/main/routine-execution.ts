import type { Routine, RoutineRun, Session } from "@jingler/core"
import type { RoutineExecution } from "./routine-scheduler.js"
export interface RoutineExecutionPorts {
  validate(routine: Routine): Promise<unknown>
  create(routine: Routine, run: RoutineRun): Promise<Session>
  setMode(id: string): Promise<unknown>
  prompt(session: Session, routine: Routine, signal: AbortSignal): ReturnType<RoutineExecution["execute"]>
}
/** All durable claims enter the same production creation, mode and turn gates. */
export const routineExecution = (ports: RoutineExecutionPorts): RoutineExecution["execute"] => async (routine, run, signal, current, link) => {
  const check = async () => {
    if (signal.aborted || !await current()) throw new Error("Routine changed or cancelled before dispatch")
    await ports.validate(routine)
    if (signal.aborted || !await current()) throw new Error("Routine changed or cancelled during validation")
  }
  await check()
  const session = await ports.create(routine, run)
  await check()
  if (session.id !== run.requestedSessionId || session.routineOccurrence?.routineId !== run.routineId || session.routineOccurrence.runId !== run.id) throw new Error("Created session does not match its reserved occurrence")
  if (!session.checkpointSafeMode || session.checkpointExecutionHistory !== "clean" || session.workspaceLifecycle?.status !== "setup-skipped") throw new Error("Safe creation did not persist clean history and skipped setup")
  await ports.setMode(session.id)
  await check()
  await link()
  await check()
  return ports.prompt(session, routine, signal)
}
