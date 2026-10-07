import type { Session } from "@jingler/core"

interface Closure {
  readonly reason: string
  readonly token: symbol
}

const safeModes = new Set<string>()
const checkpointGenerations = new Map<string, number>()
export const checkpointTurnGeneration = (sessionId: string): number => checkpointGenerations.get(sessionId) ?? 0
const checkpointOwners = new Map<string, symbol>()
export const setWorkspaceCheckpointMode = (sessionId: string, enabled: boolean): void => { if (enabled) safeModes.add(sessionId); else safeModes.delete(sessionId) }
export const workspaceCheckpointMode = (sessionId: string): boolean => safeModes.has(sessionId)
export const checkpointTurnOwner = (sessionId: string): symbol | undefined => checkpointOwners.get(sessionId)

const closed = new Map<string, Closure>()
const readiness = new Map<string, string>()

/** Persisted setup/archive state gates every entrypoint, including after restart. */
export const setWorkspaceAdmissionReadiness = (sessionId: string, reason?: string): void => {
  if (reason) readiness.set(sessionId, reason)
  else readiness.delete(sessionId)
}
const active = new Map<string, Set<{ readonly action: string }>>()
const waiters = new Map<string, Set<() => void>>()

export interface WorkspaceActivity {
  readonly sessionId: string
  readonly action: string
  release(): void
}

export const workspaceAdmissionClosed = (sessionId: string): boolean => closed.has(sessionId)

export const workspaceAdmissionReason = (sessionId: string): string | undefined => closed.get(sessionId)?.reason ?? readiness.get(sessionId)

const acquire = (sessionId: string, action: string, lifecycleOwner?: symbol): WorkspaceActivity => {
  if (lifecycleOwner !== undefined && closed.get(sessionId)?.token !== lifecycleOwner) {
    throw new Error("Workspace lifecycle owner does not match admission closure.")
  }
  if (lifecycleOwner === undefined && safeModes.has(sessionId)) throw new Error("Checkpoint-safe mode blocks overlapping/unsupported workspace execution. Interactive terminals and delegated children are unsupported.")
  const reason = lifecycleOwner !== undefined ? undefined : workspaceAdmissionReason(sessionId)
  if (reason) throw new Error(`Workspace is unavailable while ${reason}.`)
  const token = { action }
  const entries = active.get(sessionId) ?? new Set()
  entries.add(token)
  active.set(sessionId, entries)
  let released = false
  return {
    sessionId,
    action,
    release: () => {
      if (released) return
      released = true
      entries.delete(token)
      if (entries.size > 0) return
      active.delete(sessionId)
      const listeners = waiters.get(sessionId)
      waiters.delete(sessionId)
      for (const listener of listeners ?? []) listener()
    }
  }
}

export const acquireWorkspaceActivity = (sessionId: string, action: string): WorkspaceActivity =>
  acquire(sessionId, action)

/** Internal setup/cleanup work runs under the closure it owns, without opening public admission. */
export const acquireWorkspaceLifecycleActivity = (sessionId: string, action: string, owner: symbol): WorkspaceActivity =>
  acquire(sessionId, action, owner)

/** Convert the capture closure into a turn owner synchronously, with no admission gap. */
export const acquireCheckpointTurnOwner = (sessionId: string, closure: symbol): WorkspaceActivity => {
  const activity = acquire(sessionId, "checkpoint-owner-turn", closure)
  const owner = Symbol("checkpoint-owner-turn")
  checkpointOwners.set(sessionId, owner)
  checkpointGenerations.set(sessionId, checkpointTurnGeneration(sessionId) + 1)
  reopenWorkspaceAdmission(sessionId, closure)
  return { ...activity, release: () => { if (checkpointOwners.get(sessionId) === owner) checkpointOwners.delete(sessionId); activity.release() } }
}
export const acquireWorkspaceToolActivity = (sessionId: string, owner?: symbol): WorkspaceActivity => {
  if (!safeModes.has(sessionId)) return acquireWorkspaceActivity(sessionId, "tool")
  if (!owner || checkpointOwners.get(sessionId) !== owner || workspaceAdmissionReason(sessionId)) throw new Error("Checkpoint owner tool admission refused.")
  // No closure is held during owner tools; other public entrypoints remain denied.
  const mode = safeModes.delete(sessionId)
  try { return acquireWorkspaceActivity(sessionId, "owner-tool") }
  finally { if (mode) safeModes.add(sessionId) }
}
export const closeWorkspaceAdmission = (sessionId: string, reason: string): symbol => {
  const existing = closed.get(sessionId)
  if (existing) {
    throw new Error(`Workspace is already unavailable while ${existing.reason}.`)
  }
  const token = Symbol(reason)
  closed.set(sessionId, { reason, token })
  return token
}

export const reopenWorkspaceAdmission = (sessionId: string, token: symbol): boolean => {
  if (closed.get(sessionId)?.token !== token) return false
  closed.delete(sessionId)
  return true
}

export const waitForWorkspaceIdle = async (sessionId: string, timeoutMs = 15_000): Promise<void> => {
  if (!active.has(sessionId)) return
  await new Promise<void>((resolve, reject) => {
    const listeners = waiters.get(sessionId) ?? new Set<() => void>()
    const done = () => {
      clearTimeout(timer)
      listeners.delete(done)
      resolve()
    }
    listeners.add(done)
    waiters.set(sessionId, listeners)
    const timer = setTimeout(() => {
      listeners.delete(done)
      if (listeners.size === 0) waiters.delete(sessionId)
      reject(new Error(`Timed out waiting for workspace ${sessionId} activity to stop.`))
    }, timeoutMs)
    timer.unref?.()
  })
}

export const workspaceActivityCount = (sessionId: string): number => active.get(sessionId)?.size ?? 0

export const resetWorkspaceAdmissions = (): void => {
  safeModes.clear()
  checkpointOwners.clear()
  checkpointGenerations.clear()
  closed.clear()
  readiness.clear()
  active.clear()
  waiters.clear()
}

/** Never infer descendant shutdown from history that cannot be owned on this platform. */
export const workspaceHasUnprovenProcesses = (session: Session): boolean =>
  session.checkpointPtyHistory === true || (process.platform === "win32" && session.workspaceMode !== "direct" && session.checkpointExecutionHistory !== "clean")
