import { Effect } from "effect"

/**
 * Owners currently running in a session, keyed by session id.
 *
 * The unit of concurrency is the OWNER, not the session: many owners may run at
 * once against the session's shared worktree (a chat per chatId, plan execution
 * per `plan:<id>`, a planning round) — like Conductor's shared-workspace mode we
 * don't serialize or lock those against each other, and concurrent edits are the
 * operator's responsibility. But a SINGLE owner is still single-flight: a second
 * run for an owner already live is refused, because two runs sharing one owner
 * (the same chat, the same plan, the same worktree's plan artifact) would orphan
 * each other's fibers, steal the `active` slot, or clobber one shared file.
 */
const reservations = new Map<string, Set<string>>()

/**
 * Reserve a run for `ownerId` in a session. Returns `false` — refused — when that
 * owner is already running; `true` when admitted (and records it). Distinct
 * owners are always admitted, which is what lets many chats run concurrently.
 */
export const reserveSessionRun = (
  sessionId: string,
  ownerId: string
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId) ?? new Set<string>()
    if (owners.has(ownerId)) return false
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
