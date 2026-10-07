import type { AuthSession } from "@jingler/core"
import { GitError } from "@jingler/core"
import { Effect } from "effect"

/** Reuse the desktop's authoritative token validation; cached sign-in is insufficient. */
export const revalidateRoutineAuth = (getSession: () => Effect.Effect<AuthSession | null>) => Effect.suspend(getSession).pipe(
  Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new GitError({ message: "Sign-in revalidation timed out" }) }),
  Effect.flatMap(session => session && Date.parse(session.expiresAt) > Date.now() ? Effect.void : Effect.fail(new GitError({ message: "Sign in before running routines" }))),
  Effect.interruptible
)

/** Share startup attempts, but release a rejected attempt so the next sign-in can retry. */
export const routineStartup = (start: () => Promise<void>) => {
  let starting: Promise<void> | undefined
  return () => {
    starting ??= start().finally(() => { starting = undefined })
    return starting
  }
}
