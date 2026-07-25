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
 *
 * Each reservation records WHO holds it, not merely that it is held. A holder can
 * be superseded while it is still unwinding — `AgentRunner` reclaims the slot from
 * a run whose turn has settled but whose harness lives on servicing a background
 * task — and that superseded run still carries a finalizer which fires whenever
 * its harness finally exits. With no identity to check, the late finalizer frees
 * the slot out from under the run that replaced it, and the chat quietly loses the
 * guarantee: the next prompt is admitted alongside a live turn and the two race
 * one transcript. Releases are therefore no-ops unless the caller still holds it.
 */
const reservations = new Map<string, Map<string, RunHolder>>()

/** Opaque identity for one reservation holder — object identity is the point. */
export type RunHolder = Record<never, never>

/**
 * Reserve a run for `ownerId` in a session. Returns `false` — refused — when that
 * owner is already running; `true` when admitted (and records `holder` as owning
 * the slot). Distinct owners are always admitted, which is what lets many chats
 * run concurrently.
 */
export const reserveSessionRun = (
  sessionId: string,
  ownerId: string,
  holder: RunHolder
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId) ?? new Map<string, RunHolder>()
    if (owners.has(ownerId)) return false
    owners.set(ownerId, holder)
    reservations.set(sessionId, owners)
    return true
  })

/**
 * Release `ownerId`'s reservation — but only if `holder` still owns it.
 *
 * A mismatch means this caller was superseded, so it has nothing of its own left
 * to free and the current holder's slot must be left alone.
 */
export const releaseSessionRun = (
  sessionId: string,
  ownerId: string,
  holder: RunHolder
): Effect.Effect<void> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId)
    if (owners === undefined) return
    if (owners.get(ownerId) !== holder) return
    owners.delete(ownerId)
    if (owners.size === 0) reservations.delete(sessionId)
  })

export const anySessionRunActive: Effect.Effect<boolean> = Effect.sync(
  () => reservations.size > 0
)

/**
 * Take `ownerId`'s slot over from whoever holds it now.
 *
 * Used for the one legitimate supersession: a run whose turn has settled but whose
 * harness lives on servicing a background task. Unconditional by design — the
 * point is to displace the incumbent — and the displaced holder's own release then
 * no-ops, so its late finalizer cannot free the slot it no longer owns.
 */
export const reclaimSessionRun = (
  sessionId: string,
  ownerId: string,
  holder: RunHolder
): Effect.Effect<void> =>
  Effect.sync(() => {
    const owners = reservations.get(sessionId) ?? new Map<string, RunHolder>()
    owners.set(ownerId, holder)
    reservations.set(sessionId, owners)
  })
