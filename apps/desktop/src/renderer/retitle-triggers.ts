import type { Session } from "@jingler/core"

/**
 * Auto-named session ids whose plan JUST appeared — present in `next` (a plan was
 * proposed / the session is in plan mode) but absent in `prev`. This is the
 * trigger for App.tsx to retitle a session right after PLANNING, so its name
 * reflects the work as soon as there's a plan, instead of staying "Untitled"
 * until the whole run (plan + execution) finally completes.
 *
 * Only `autoTitle === true` sessions qualify — a manually-named session is pinned
 * and never auto-retitled. Pure, so the App effect stays thin wiring.
 */
export const newlyPlannedSessionIds = (
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
  sessions: ReadonlyArray<Pick<Session, "id" | "autoTitle" | "semanticBranchPending">>
): ReadonlyArray<string> =>
  [...next].filter(
    (id) => {
      const session = sessions.find((s) => s.id === id)
      return !prev.has(id) &&
        (session?.autoTitle === true || session?.semanticBranchPending === true)
    }
  )

/** Whether a settled turn still needs display-title or semantic-branch generation. */
export const needsSessionRetitle = (
  session: Pick<Session, "autoTitle" | "semanticBranchPending"> | undefined
): boolean => session?.autoTitle === true || session?.semanticBranchPending === true
