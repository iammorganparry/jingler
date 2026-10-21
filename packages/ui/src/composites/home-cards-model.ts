import { UNTITLED_SESSION, type Session, type SessionActivity } from "@jingler/core"

export type HomeNeedsYouCard = {
  readonly sessionId: string
  readonly title: string
  readonly text: string
  /** No longer waiting on the operator: shown neutral, dismiss only. */
  readonly stale: boolean
}
export type HomeRunningRow = { readonly sessionId: string; readonly title: string; readonly activity: string }

const NEEDS_YOU = new Set(["needs-input", "needs-approval"])

/**
 * Home cards from live activities. `seen` = sessions that have shown a needs-you card;
 * a seen session that is no longer pending stays as a stale card until dismissed.
 */
export function deriveHomeCards(input: {
  readonly sessions: ReadonlyArray<Session>
  readonly liveActivity: Readonly<Record<string, SessionActivity>>
  readonly seen: ReadonlySet<string>
  readonly dismissed: ReadonlySet<string>
}): { readonly needsYou: ReadonlyArray<HomeNeedsYouCard>; readonly running: ReadonlyArray<HomeRunningRow> } {
  const needsYou: HomeNeedsYouCard[] = []
  const running: HomeRunningRow[] = []
  for (const session of input.sessions) {
    if (session.archived) continue
    const title = session.title || UNTITLED_SESSION
    const activity = input.liveActivity[session.id]
    if (activity && NEEDS_YOU.has(activity.kind)) {
      needsYou.push({ sessionId: session.id, title, text: activity.verb, stale: false })
    } else if (input.seen.has(session.id) && !input.dismissed.has(session.id)) {
      needsYou.push({ sessionId: session.id, title, text: "", stale: true })
    }
    if (activity && !NEEDS_YOU.has(activity.kind)) {
      running.push({ sessionId: session.id, title, activity: [activity.verb, activity.target].filter(Boolean).join(" ") })
    }
  }
  return { needsYou, running }
}
