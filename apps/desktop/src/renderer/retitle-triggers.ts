import type { Session, SessionActivity } from "@jingler/core"

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

/**
 * Session ids whose agent run JUST STARTED (absent in `prev`, present in `next`)
 * and whose semantic branch is still pending. This names a fresh task within
 * seconds of the first prompt — concurrent with the run, which never waits on
 * it — instead of leaving "Naming branch…" up through the whole first turn.
 *
 * Gated on `semanticBranchPending` (not `autoTitle`) on purpose: once the
 * branch exists this edge goes quiet, so routine later turns don't spend an
 * extra title call on both their start AND completion edges.
 */
export const newlyStartedSessionIds = (
  prev: Record<string, SessionActivity>,
  next: Record<string, SessionActivity>,
  sessions: ReadonlyArray<Pick<Session, "id" | "semanticBranchPending">>
): ReadonlyArray<string> =>
  sessions
    .filter(
      (s) =>
        s.semanticBranchPending === true && prev[s.id] == null && next[s.id] != null
    )
    .map((s) => s.id)
