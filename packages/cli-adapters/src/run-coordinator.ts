import { Effect } from "effect"

/** One owner per session may mutate its shared worktree at a time. */
const reservations = new Map<string, string>()

export const reserveSessionRun = (
  sessionId: string,
  ownerId: string
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (reservations.has(sessionId)) return false
    reservations.set(sessionId, ownerId)
    return true
  })

export const releaseSessionRun = (
  sessionId: string,
  ownerId: string
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (reservations.get(sessionId) === ownerId) reservations.delete(sessionId)
  })

export const anySessionRunActive: Effect.Effect<boolean> = Effect.sync(
  () => reservations.size > 0
)
