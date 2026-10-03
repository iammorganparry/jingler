interface Closure {
  readonly reason: string
  readonly token: symbol
}

const closed = new Map<string, Closure>()
const active = new Map<string, Set<{ readonly action: string }>>()
const waiters = new Map<string, Set<() => void>>()

export interface WorkspaceActivity {
  readonly sessionId: string
  readonly action: string
  release(): void
}

export const workspaceAdmissionReason = (sessionId: string): string | undefined => closed.get(sessionId)?.reason

const acquire = (sessionId: string, action: string, lifecycleOwner: boolean): WorkspaceActivity => {
  const reason = lifecycleOwner ? undefined : closed.get(sessionId)?.reason
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
  acquire(sessionId, action, false)

/** Internal setup/cleanup work runs under the closure it owns, without opening public admission. */
export const acquireWorkspaceLifecycleActivity = (sessionId: string, action: string): WorkspaceActivity =>
  acquire(sessionId, action, true)

export const closeWorkspaceAdmission = (sessionId: string, reason: string): symbol => {
  const existing = closed.get(sessionId)
  if (existing) {
    if (existing.reason === reason) return existing.token
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
  closed.clear()
  active.clear()
  waiters.clear()
}
