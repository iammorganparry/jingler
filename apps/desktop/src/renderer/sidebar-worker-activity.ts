import type {
  SessionActivity,
  WorkerActivity,
  WorkerLifecycleStatus,
  WorkerState
} from "@jingler/core"

export interface SidebarWorkerState {
  readonly id: string
  readonly attempt: number
  readonly status: WorkerLifecycleStatus
  readonly statusMessage: string | null
}

export type SidebarWorkerSnapshot = Readonly<Record<string, SidebarWorkerState>>

const fromWorkerState = (state: WorkerState): SidebarWorkerState => ({
  id: state.worker.agentId,
  attempt: state.worker.attempt,
  status: state.status,
  statusMessage: state.message
})

const replaceWorker = (
  snapshot: SidebarWorkerSnapshot,
  worker: SidebarWorkerState
): SidebarWorkerSnapshot => {
  const current = snapshot[worker.id]
  if (current !== undefined && current.attempt > worker.attempt) return snapshot
  return { ...snapshot, [worker.id]: worker }
}

/** Fold the session-wide main-process feed into the sidebar's minimal state. */
export const foldSidebarWorkerActivity = (
  snapshot: SidebarWorkerSnapshot,
  activity: WorkerActivity
): SidebarWorkerSnapshot => {
  if (activity._tag === "Reset") {
    const initial = activity.mode === "replace" ? {} : snapshot
    return activity.workers.reduce(
      (next, worker) => replaceWorker(next, fromWorkerState(worker)),
      initial
    )
  }
  if (activity._tag === "State") {
    return replaceWorker(snapshot, fromWorkerState(activity))
  }
  const current = snapshot[activity.worker.agentId]
  if (current !== undefined && current.attempt >= activity.worker.attempt) {
    return snapshot
  }
  return replaceWorker(snapshot, {
    id: activity.worker.agentId,
    attempt: activity.worker.attempt,
    status: "running",
    statusMessage: null
  })
}

/** Sidebar rollup for workers that outlive the orchestrator's own turn. */
export const orchestrationSessionActivity = (
  agents: ReadonlyArray<
    Pick<SidebarWorkerState, "id" | "status" | "statusMessage">
  >
): SessionActivity | null => {
  const active = agents.filter(
    (agent) => agent.status === "queued" || agent.status === "running"
  )
  if (active.length === 0) return null
  const only = active.length === 1 ? active[0] : null
  return {
    kind: "delegating",
    verb: "Delegating",
    target: only?.statusMessage?.trim() || only?.id || `${active.length} agents`
  }
}
