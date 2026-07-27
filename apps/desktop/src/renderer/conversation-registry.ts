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
 *
 * Two things keep that arrangement from costing unbounded memory:
 *
 *  - **Residency is capped** (`actor-eviction.ts`). Keeping an actor alive across
 *    unmounts is the point; keeping every actor the operator has EVER opened alive
 *    was an accident, and it retained each session's whole parsed transcript plus
 *    its full diff for the life of the app.
 *  - **Publishing is coalesced** (`coalesce.ts`). The subscription fires per
 *    streamed token, and what it publishes is read at human speed.
 */
import type { ActorRefFrom, SnapshotFrom } from "xstate"
import { createActor } from "xstate"
import { useSyncExternalStore } from "react"
import type { ActivityPhase, Session, SessionActivity } from "@jingler/core"
import { activityOf, latestPlan } from "@jingler/core"
import { conversationMachine } from "./conversation-machine.js"
import { setSessionActivity } from "./session-activity.js"
import { setPlanPresent } from "./plan-presence.js"
import { clearSessionDiff, diffCounts, setSessionDiff } from "./diff-presence.js"
import { isSessionVisible } from "./active-session.js"
import type { ActorCandidate } from "./actor-eviction.js"
import { keysToEvict } from "./actor-eviction.js"
import { createCoalescer } from "./coalesce.js"
import type { NotifiableState } from "./notifier.js"
import { notificationFor } from "./notifier.js"
import { rpc } from "./rpc-client.js"

type ConversationActor = ActorRefFrom<typeof conversationMachine>
type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>

/**
 * How long the derived stores lag the actor. Perceptually immediate for a sidebar
 * spinner, and long enough that a turn's worth of tokens collapses into a handful
 * of publishes instead of one apiece.
 */
const PUBLISH_MS = 100

const registry = new Map<string, ConversationActor>()
const snapshots = new Map<string, ConversationSnapshot>()
let chatActivities: Record<string, Record<string, SessionActivity>> = {}
const EMPTY_CHAT_ACTIVITIES: Readonly<Record<string, SessionActivity>> = {}
const activityListeners = new Set<() => void>()
const sharedPlanBodies = new Map<string, string>()
/**
 * Previous observation per actor, for the notification edge detector — see
 * `notificationFor`. Held per key (and dropped with the actor) rather than in the
 * subscription closure, because the observation is now made in the flush.
 */
const notifyBaselines = new Map<string, NotifiableState>()
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

/** Broadcast a chat's plan to the session's other chats, when it actually changed. */
const broadcastSharedPlan = (key: string, snap: ConversationSnapshot): void => {
  const plan = latestPlan(snap.context.messages)
  if (plan === null) return
  const sessionId = snap.context.session.id
  const body = JSON.stringify(plan)
  if (sharedPlanBodies.get(sessionId) === body) return
  sharedPlanBodies.set(sessionId, body)
  for (const [otherKey, otherActor] of registry) {
    if (otherKey === key || !otherKey.startsWith(`${sessionId}:`)) continue
    otherActor.send({
      type: "SHARED_PLAN_UPDATED",
      plan,
      producingChatId: snap.context.sharedPlanChatId ?? snap.context.chatId
    })
  }
}

/**
 * Everything the registry derives from one actor's latest snapshot: live activity,
 * plan presence, diff totals, the cross-chat plan broadcast, and the desktop
 * notification edge.
 *
 * Reads the session off the SNAPSHOT rather than off a captured argument, so a
 * retitle mid-run announces under the new name.
 */
const publishSnapshot = (key: string, snap: ConversationSnapshot): void => {
  const session = snap.context.session
  const chatId = snap.context.chatId
  const activity = activityFor(snap)
  // Nothing is announced until the transcript has LOADED, and the first loaded
  // snapshot becomes the baseline rather than an edge.
  //
  // `notificationFor`'s own first-observation rule is not enough on its own: the
  // actor's initial `start()` snapshot has empty messages and so reports no
  // activity, and the restored transcript arrives on a LATER transition. A session
  // that was already blocked when the app last closed therefore looked like a
  // null → needs-input edge on observation #2, and announced "Waiting for your
  // input" for state that predates the operator opening the app — precisely the
  // stale-replay noise the rule exists to prevent.
  const observed: NotifiableState = { activity, outcome: snap.context.lastOutcome }
  const announce = snap.context.loaded
    ? notificationFor(session.title, notifyBaselines.get(key) ?? null, observed)
    : null
  if (snap.context.loaded) notifyBaselines.set(key, observed)

  broadcastSharedPlan(key, snap)
  publishChatActivity(session.id, chatId, activity)
  recomputeSession(session.id, snap)
  // Fire-and-forget, and deliberately last: a notification that fails must never
  // take the status stores down with it. Main decides whether this actually
  // surfaces (window focus + the operator's prefs).
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
}

/**
 * The flush that publishes derived state, one batch per window.
 *
 * Being deferred also preserves a property the old `queueMicrotask` had: the very
 * first (synchronous) notification from `start()` can arrive while a component is
 * rendering, because the actor is created inside `useMemo`, and it must not write
 * to the status/plan stores mid-render.
 */
const publishes = createCoalescer<ConversationSnapshot>((batch) => {
  for (const [key, snap] of batch) {
    // Disposed or evicted between the push and the flush — publishing now would
    // resurrect state for an actor that no longer exists.
    if (!registry.has(key)) continue
    publishSnapshot(key, snap)
  }
}, PUBLISH_MS)

/** Stop + forget one actor, leaving the stores it published alone. */
const forget = (key: string): void => {
  registry.get(key)?.stop()
  registry.delete(key)
  snapshots.delete(key)
  notifyBaselines.delete(key)
  publishes.cancel(key)
}

/**
 * Drop the least-recently-used idle actors once residency exceeds the cap.
 *
 * Deliberately does NOT clear the evicted session's activity/plan/diff presence.
 * Those stores describe the session, not the actor: an idle session's last
 * published plan presence and diff totals are still true, and blanking them would
 * make the Plan tab and the `+N −N` counters vanish from a session that still has
 * both, purely because the operator looked at six other sessions. They are
 * recomputed from the transcript when the session is next opened.
 */
const evictIdleActors = (keep: string): void => {
  // `registry`'s insertion order IS recency order — `getConversationActor`
  // re-inserts on every hit — so iterating it gives the LRU-first list the policy
  // wants. `snapshots` would NOT: re-setting an existing key leaves its original
  // position, so its order is creation order and a re-visited actor would still
  // look like the oldest thing in the cache.
  const candidates: Array<ActorCandidate> = []
  for (const key of registry.keys()) {
    const snapshot = snapshots.get(key)
    // An actor with no snapshot yet can't be judged, so it counts towards
    // residency but is never the one that goes. (XState emits the initial snapshot
    // on `start()`, so in practice this doesn't happen.)
    candidates.push(
      snapshot === undefined
        ? { key, sessionId: "", phase: "running", queuedCount: 0, pendingText: "" }
        : {
            key,
            sessionId: snapshot.context.session.id,
            phase: phaseOf(snapshot),
            queuedCount: snapshot.context.queued.length,
            pendingText: snapshot.context.pendingText
          }
    )
  }
  for (const key of keysToEvict(candidates, { keep, isVisible: isSessionVisible })) {
    forget(key)
  }
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
 *
 * Residency is capped, so an actor for a session left alone long enough may have
 * been evicted — in which case this rebuilds it and the transcript re-loads from
 * disk, exactly as it does on a cold start.
 */
export const getConversationActor = (
  session: Session,
  chatId: string = session.activeChatId
): ConversationActor => {
  const key = registryKey(session.id, chatId)
  const existing = registry.get(key)
  if (existing) {
    // Re-insert to move this key to the most-recently-used end: `Map` keeps
    // insertion order, and `set` on an existing key would leave it in place — so
    // without the delete, the eviction policy would see creation order and drop
    // the session the operator switches back to most.
    registry.delete(key)
    registry.set(key, existing)
    existing.send({ type: "SESSION_UPDATED", session })
    return existing
  }

  const actor = createActor(conversationMachine, { input: { session, chatId } })
  // Only the two cheap bookkeeping writes happen per token; everything derived
  // from the transcript is left to the coalesced flush. Deriving it here meant
  // re-walking every message and re-scanning the whole worktree diff on every
  // streamed delta, which on a long session is most of what the renderer did.
  actor.subscribe((snap) => {
    snapshots.set(key, snap)
    publishes.push(key, snap)
  })
  actor.start()
  registry.set(key, actor)
  evictIdleActors(key)
  return actor
}

/** Stop + forget a session's actor (call when the session is deleted). */
export const disposeConversationActor = (sessionId: string): void => {
  for (const key of [...registry.keys()]) {
    if (!key.startsWith(`${sessionId}:`)) continue
    forget(key)
  }
  delete chatActivities[sessionId]
  sharedPlanBodies.delete(sessionId)
  setSessionActivity(sessionId, null)
  setPlanPresent(sessionId, false)
  clearSessionDiff(sessionId)
}

export const disposeChatActor = (sessionId: string, chatId: string): void => {
  const key = registryKey(sessionId, chatId)
  forget(key)
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
