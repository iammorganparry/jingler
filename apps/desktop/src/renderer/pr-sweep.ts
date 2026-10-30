import { issueReferenceForProvider, type PrState, type Session, type SessionPrStatus, sessionPrsOf } from "@jingler/core"

/**
 * Session ids whose linked PR has MERGED and whose linked issue should now be
 * closed — opted in via `automations.closeOnMerge`, and not already closed.
 *
 * This is all that remains of what used to be the "archive sweep". Archiving on
 * merge was wrong: a session record holds a single `prNumber`, but one session
 * routinely outlives several PRs (open one, merge it, keep working off the same
 * worktree, open the next). Merging PR #204 therefore said nothing about whether
 * the WORK was done, and a live multi-PR session would silently vanish from the
 * sidebar mid-flight. Retiring a session is now always the operator's call — the
 * merged/closed state only badges the row.
 *
 * Closing the linked ISSUE survives that change because it's a statement about
 * the issue, not about whether the session is finished.
 *
 * `alreadyClosed` is load-bearing: a merged PR stays merged forever, so without
 * it the poll would re-fire the close on every tick.
 */
/**
 * Sessions whose linked PR has just RESOLVED (merged or closed) and should raise
 * a desktop notification, paired with which it was.
 *
 * Pure, and keyed off the same `Record<sessionId, PrState>` as
 * `issuesToCloseOnMerge`, because the first version of this lived inline in the
 * effect and indexed that Record with the loop's numeric INDEX — always
 * undefined for a real session id, so the notification never fired and the whole
 * "PR merged/closed" kind was dead code that still typechecked (TypeScript
 * permits numeric indexing of a `Record<string, T>`). Extracted here so the
 * lookup is exercised by a test rather than by eye.
 *
 * `alreadyNotified` plays the same role as `alreadyClosed` above: a merged PR
 * stays merged, so without it the poll re-announces it every tick.
 */
/** One PR in a session's stack with its last polled status. */
export interface PrLayer {
  readonly number: number
  readonly status: SessionPrStatus
}

/** PR numbers to poll for a session, bottom of the stack first. A pre-stack session reads as one PR. */
export const prNumbersOf = (session: Session): ReadonlyArray<number> =>
  sessionPrsOf(session).map((pr) => pr.number)

/** Dedupe key for "already announced": one notification per (session, PR), never per session. */
export const prNotifyKey = (sessionId: string, prNumber: number): string => `${sessionId}#${prNumber}`

/** A PR layer that has just RESOLVED, and how. `stackedUnder` is the next layer up, when there is one. */
export interface ResolvedPr {
  readonly session: Session
  readonly number: number
  readonly state: "merged" | "closed"
  readonly stackedUnder?: number
}

export const prsToNotify = (
  stacks: Readonly<Record<string, ReadonlyArray<PrLayer>>>,
  sessions: ReadonlyArray<Session>,
  alreadyNotified: ReadonlySet<string>
): ReadonlyArray<ResolvedPr> =>
  sessions.flatMap((session) =>
    (stacks[session.id] ?? []).flatMap((layer, index, layers) => {
      const state = layer.status.state
      if (state !== "merged" && state !== "closed") return []
      if (alreadyNotified.has(prNotifyKey(session.id, layer.number))) return []
      const above = layers[index + 1]
      return [{ session, number: layer.number, state, ...(above ? { stackedUnder: above.number } : {}) }]
    })
  )

/**
 * Lifecycle of a whole stack, for the close-on-merge sweep: it is "merged" only once EVERY layer
 * has resolved and at least one merged ("closed" if none did). While any layer is unresolved the
 * stack is still "open", so a merged bottom layer never closes the issue early.
 */
export const stackLifecycle = (layers: ReadonlyArray<PrLayer>): PrState | undefined => {
  if (layers.length === 0) return undefined
  const states = layers.map((layer) => layer.status.state)
  if (!states.every((state) => state === "merged" || state === "closed")) return "open"
  return states.includes("merged") ? "merged" : "closed"
}

// Lower is worse: failing CI, then closed, then running/queued, then healthy, then merged.
const layerSeverity = ({ state, checks }: SessionPrStatus): number => {
  if (state === "merged") return 4
  if (state === "closed") return 1
  if (checks === "fail") return 0
  return checks === "running" || checks === "pending" ? 2 : 3
}

/** The status a session displays for its stack: the worst layer wins; merged lower layers never hide a failing upper one. */
export const worstPrStatus = (layers: ReadonlyArray<PrLayer>): SessionPrStatus | undefined =>
  layers.reduce<SessionPrStatus | undefined>(
    (worst, { status }) => (worst === undefined || layerSeverity(status) < layerSeverity(worst) ? status : worst),
    undefined
  )

export const issuesToCloseOnMerge = (
  prStates: Readonly<Record<string, PrState>>,
  sessions: ReadonlyArray<Session>,
  alreadyClosed: ReadonlySet<string>
): ReadonlyArray<string> =>
  sessions
    .filter(
      (session) => {
        const issue = issueReferenceForProvider(session, "github")
        return (
          prStates[session.id] === "merged" &&
          issue !== undefined &&
          Number.isSafeInteger(Number(issue.id)) &&
          Number(issue.id) > 0 &&
          session.automations?.closeOnMerge === true &&
          !alreadyClosed.has(session.id)
        )
      }
    )
    .map((s) => s.id)
