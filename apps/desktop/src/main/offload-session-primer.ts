import { Effect } from "effect"

export interface PrimeableOffloadSession {
  readonly id: string
  readonly worktreePath?: string | null
}

/** Best-effort bounded primer; persistence succeeds independently of stale sessions. */
export const primeOffloadSessions = <E>(
  sessions: ReadonlyArray<PrimeableOffloadSession>,
  prime: (cwd: string, sessionId: string) => Effect.Effect<unknown, E>
): Effect.Effect<void> =>
  Effect.forEach(
    sessions,
    (session) => session.worktreePath
      ? prime(session.worktreePath, session.id).pipe(Effect.ignore)
      : Effect.void,
    { concurrency: 3, discard: true }
  )
