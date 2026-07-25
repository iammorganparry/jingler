/**
 * A module-level registry of running conversation actors, keyed by session id.
 *
 * The conversation pane is mounted keyed by the *active* session, so switching
 * sessions unmounts it. If the actor lived inside the component (via
 * `useMachine`) that unmount would stop it — tearing down the invoked
 * `agentStream`, whose cleanup interrupts the RPC stream and kills the live run
 * in the main process. Keeping mounted-but-hidden panes isn't an option either
 * (the virtualized transcript's measurement cache corrupts when hidden).
 *
 * So the actor is hoisted here instead: created once per session and kept
 * running across mounts, so a background session's agent keeps working while the
 * operator looks at another. The view just attaches to (and detaches from) the
 * existing actor. Live status + plan-tab presence are published straight from
 * the actor's subscription here, so they stay correct even while the pane that
 * would otherwise report them is unmounted. Actors are disposed when their
 * session is deleted (see `App.tsx`).
 */
import type { ActorRefFrom, SnapshotFrom } from "xstate"
import { createActor } from "xstate"
import { useSyncExternalStore } from "react"
import type { ActivityPhase, Session, SessionActivity } from "@starbase/core"
import { activityOf, latestPlan } from "@starbase/core"
import { conversationMachine } from "./conversation-machine.js"
import { setSessionActivity } from "./session-activity.js"
import { setPlanPresent } from "./plan-presence.js"
import { clearSessionDiff, diffCounts, setSessionDiff } from "./diff-presence.js"
import { isSessionVisible } from "./active-session.js"
import type { NotifiableState } from "./notifier.js"
import { notificationFor } from "./notifier.js"
import { rpc } from "./rpc-client.js"

type ConversationActor = ActorRefFrom<typeof conversationMachine>
type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>

const registry = new Map<string, ConversationActor>()
const snapshots = new Map<string, ConversationSnapshot>()
let chatActivities: Record<string, Record<string, SessionActivity>> = {}
const EMPTY_CHAT_ACTIVITIES: Readonly<Record<string, SessionActivity>> = {}
const activityListeners = new Set<() => void>()
const sharedPlanBodies = new Map<string, string>()
const registryKey = (sessionId: string, chatId: string): string =>
  `${sessionId}:${chatId}`

/** Where the machine is, in the terms `activityOf` reasons about. */
const phaseOf = (snap: ConversationSnapshot): ActivityPhase => {
  if (snap.matches("running")) return "running"
  // The turn is over — we're either waiting for the halt to land or re-reading
  // the worktree diff. Both are "settling": the sidebar should not claim the
  // agent is still thinking, but nor is the session idle and ready.
  if (snap.matches("stopping") || snap.matches("refreshingDiff")) return "settling"
  return "idle"
}

/**
 * Derive the live activity the sidebar/tab bar show from a machine snapshot.
 * The interesting part lives in `activityOf` (pure, and tested in core) — this
 * only translates machine states into a phase.
 */
const activityFor = (snap: ConversationSnapshot): SessionActivity | null =>
  activityOf(snap.context.messages, phaseOf(snap))

const activityPriority = (activity: SessionActivity): number =>
  activity.kind === "needs-input" || activity.kind === "needs-approval" ? 2 : 1

const publishChatActivity = (
  sessionId: string,
  chatId: string,
  activity: SessionActivity | null
): void => {
  const previous = chatActivities[sessionId] ?? {}
  const next = { ...previous }
  if (activity === null) delete next[chatId]
  else next[chatId] = activity
  chatActivities = { ...chatActivities, [sessionId]: next }
  for (const listener of activityListeners) listener()
}

const recomputeSession = (sessionId: string, preferred?: ConversationSnapshot): void => {
  const sessionSnapshots = [...snapshots.entries()]
    .filter(([key]) => key.startsWith(`${sessionId}:`))
    .map(([, snapshot]) => snapshot)
  const activities = sessionSnapshots
    .map(activityFor)
    .filter((activity): activity is SessionActivity => activity !== null)
    .sort((a, b) => activityPriority(b) - activityPriority(a))
  setSessionActivity(sessionId, activities[0] ?? null)
  setPlanPresent(
    sessionId,
    sessionSnapshots.some((snapshot) => latestPlan(snapshot.context.messages) !== null)
  )
  const diffSnapshot = preferred ?? sessionSnapshots[sessionSnapshots.length - 1]
  if (diffSnapshot === undefined) clearSessionDiff(sessionId)
  else setSessionDiff(sessionId, diffCounts(diffSnapshot.context.patch))
}

export const useChatActivities = (
  sessionId: string
): Readonly<Record<string, SessionActivity>> =>
  useSyncExternalStore(
    (listener) => {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },
    () => chatActivities[sessionId] ?? EMPTY_CHAT_ACTIVITIES,
    () => chatActivities[sessionId] ?? EMPTY_CHAT_ACTIVITIES
  )

/**
 * Get (creating + starting on first use) the persistent actor for a session.
 * The subscription publishes live status + plan presence for the whole lifetime
 * of the run, independent of whether the conversation pane is mounted.
 */
export const getConversationActor = (
  session: Session,
  chatId: string = session.activeChatId
): ConversationActor => {
  const key = registryKey(session.id, chatId)
  const existing = registry.get(key)
  if (existing) {
    existing.send({ type: "SESSION_UPDATED", session })
    return existing
  }

  const actor = createActor(conversationMachine, { input: { session, chatId } })
  // Previous observation for the edge detector — see `notificationFor`. Held per
  // actor so it dies with the session rather than leaking into the next one.
  let lastSeen: NotifiableState | null = null
  actor.subscribe((snap) => {
    // Deferred so the very first (synchronous) notification from `start()` — which
    // can happen while a component is rendering, since the actor is created inside
    // `useMemo` — doesn't notify the status/plan stores mid-render.
    const activity = activityFor(snap)
    // Nothing is announced until the transcript has LOADED, and the first loaded
    // snapshot becomes the baseline rather than an edge.
    //
    // `notificationFor`'s own first-observation rule is not enough on its own:
    // the actor's initial `start()` snapshot has empty messages and so reports
    // no activity, and the restored transcript arrives on a LATER transition. A
    // session that was already blocked when the app last closed therefore looked
    // like a null → needs-input edge on observation #2, and announced "Waiting
    // for your input" for state that predates the operator opening the app —
    // precisely the stale-replay noise the rule exists to prevent.
    const observed: NotifiableState = { activity, outcome: snap.context.lastOutcome }
    const announce = snap.context.loaded ? notificationFor(session.title, lastSeen, observed) : null
    if (snap.context.loaded) lastSeen = observed
    snapshots.set(key, snap)
    const plan = latestPlan(snap.context.messages)
    if (plan !== null) {
      const body = JSON.stringify(plan)
      if (sharedPlanBodies.get(session.id) !== body) {
        sharedPlanBodies.set(session.id, body)
        for (const [otherKey, otherActor] of registry) {
          if (otherKey === key || !otherKey.startsWith(`${session.id}:`)) continue
          otherActor.send({
            type: "SHARED_PLAN_UPDATED",
            plan,
            producingChatId: snap.context.sharedPlanChatId ?? chatId
          })
        }
      }
    }
    queueMicrotask(() => {
      publishChatActivity(session.id, chatId, activity)
      recomputeSession(session.id, snap)
      // Fire-and-forget, and deliberately last: a notification that fails must
      // never take the status stores down with it. Main decides whether this
      // actually surfaces (window focus + the operator's prefs).
      if (announce !== null) {
        void rpc
          .notifyShow({
            sessionId: session.id,
            kind: announce.kind,
            title: announce.title,
            body: announce.body,
            isActiveSession: isSessionVisible(session.id)
          })
          .catch(() => {})
      }
    })
  })
  actor.start()
  registry.set(key, actor)
  return actor
}

/** Stop + forget a session's actor (call when the session is deleted). */
export const disposeConversationActor = (sessionId: string): void => {
  for (const [key, actor] of registry) {
    if (!key.startsWith(`${sessionId}:`)) continue
    actor.stop()
    registry.delete(key)
    snapshots.delete(key)
  }
  delete chatActivities[sessionId]
  sharedPlanBodies.delete(sessionId)
  setSessionActivity(sessionId, null)
  setPlanPresent(sessionId, false)
  clearSessionDiff(sessionId)
}

export const disposeChatActor = (sessionId: string, chatId: string): void => {
  const key = registryKey(sessionId, chatId)
  registry.get(key)?.stop()
  registry.delete(key)
  snapshots.delete(key)
  publishChatActivity(sessionId, chatId, null)
  recomputeSession(sessionId)
}

/** Point every live copy of a shared plan at its replacement producing chat. */
export const rehomeSharedPlan = (
  sessionId: string,
  fromChatId: string,
  toChatId: string
): void => {
  if (fromChatId === toChatId) return
  const plan = [...snapshots.entries()]
    .filter(([key]) => key.startsWith(`${sessionId}:`))
    .filter(([, snapshot]) => snapshot.context.sharedPlanChatId === fromChatId)
    .map(([, snapshot]) => latestPlan(snapshot.context.messages))
    .find((candidate) => candidate !== null)
  if (plan === undefined || plan === null) return
  for (const [key, actor] of registry) {
    if (!key.startsWith(`${sessionId}:`)) continue
    actor.send({ type: "SHARED_PLAN_UPDATED", plan, producingChatId: toChatId })
  }
}
