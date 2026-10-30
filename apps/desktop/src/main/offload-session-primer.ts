import { activeCheckoutOf } from "@jingler/core"
import { Effect } from "effect"

export type PrimeableOffloadSession = Parameters<typeof activeCheckoutOf>[0] & {
  readonly checkpointSafeMode?: boolean
  readonly archived?: boolean
}

/** Best-effort bounded primer; persistence succeeds independently of stale sessions. */
export const primeOffloadSessions = <E>(
  sessions: ReadonlyArray<PrimeableOffloadSession>,
  prime: (cwd: string, sessionId: string) => Effect.Effect<unknown, E>
): Effect.Effect<void> =>
  Effect.forEach(
    sessions,
    (session) => {
      const { worktreePath } = activeCheckoutOf(session)
      return worktreePath && !session.checkpointSafeMode && !session.archived
        ? prime(worktreePath, session.id).pipe(Effect.ignore)
        : Effect.void
    },
    { concurrency: 3, discard: true }
  )
