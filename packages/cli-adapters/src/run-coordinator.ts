import { Effect } from "effect"

/**
 * Owners currently running in a session's shared worktree. Multiple chats (and
 * plan/planning runs) may run concurrently against the same worktree — like
 * Conductor's shared-workspace mode, we do NOT serialize or lock; concurrent
 * edits are the operator's responsibility. This map only tracks *whether*
 * anything is live (for `anySessionRunActive`), no longer *gating* a second run.
 */
const reservations = new Map<string, Set<string>>()

/**
 * Register an owner as running in a session. Always admitted — the boolean is
 * kept for call-site compatibility and is always `true`.
 */
export const reserveSessionRun = (
  sessionId: string,
  ownerId: string
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId) ?? new Set<string>()
    owners.add(ownerId)
    reservations.set(sessionId, owners)
    return true
  })

export const releaseSessionRun = (
  sessionId: string,
  ownerId: string
): Effect.Effect<void> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId)
    if (owners === undefined) return
    owners.delete(ownerId)
    if (owners.size === 0) reservations.delete(sessionId)
  })

export const anySessionRunActive: Effect.Effect<boolean> = Effect.sync(
  () => reservations.size > 0
)
