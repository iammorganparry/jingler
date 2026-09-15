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
import type {
  ActivityPhase,
  AgentFileActivity,
  Session,
  SessionActivity,
  SubagentFleetEvent,
  SubagentFleetNode,
  SubagentFleetSnapshot
} from "@jingler/core"
import {
  activityOf,
  agentFileActivityOf,
  SUBAGENT_FLEET_PROTOCOL_VERSION
} from "@jingler/core"
import {
  isSubagentFleetNodeNewer,
  type SubagentRunTreeContext
} from "@jingler/cli-adapters/runtime/subagents/subagent-run-tree-reducer"
import { conversationMachine } from "./conversation-machine.js"
import {
  parentPiSessionIdFromFleetEvents,
  projectSubagentFleetEvents
} from "./subagent-fleet-machine.js"
import { setSessionActivity } from "./session-activity.js"
import { setPlanPresent } from "./plan-presence.js"
import { clearSessionDiff, setSessionDiff } from "./diff-presence.js"
import { isSessionVisible } from "./active-session.js"
import type { ActorCandidate } from "./actor-eviction.js"
import { keysToEvict, MAX_LIVE_ACTORS } from "./actor-eviction.js"
import { createCoalescer } from "./coalesce.js"
import type { NotifiableState } from "./notifier.js"
import { notificationFor } from "./notifier.js"
import { rpc } from "./rpc-client.js"
import {
  clearSubagentTabs,
  projectSubagentTabs,
  publishActorSubagentTabs
} from "./subagent-tab-store.js"
import {
  clearAgentFileActivityChat,
  clearAgentFileActivitySession,
  publishAgentFileActivity
} from "./agent-file-activity.js"

type ConversationActor = ActorRefFrom<typeof conversationMachine>
type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>

/**
 * How long the derived stores lag the actor. Perceptually immediate for a sidebar
 * spinner, and long enough that a turn's worth of tokens collapses into a handful
 * of publishes instead of one apiece.
 */
const PUBLISH_MS = 100
const FLEET_POLL_MS = 15_000
const FLEET_DORMANT_POLL_MS = 60_000
const ACTIVE_FLEET_STATUSES: ReadonlySet<SubagentFleetNode["status"]> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])

interface FleetReconciler {
  parentPiSessionId: string
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  retryAttempt: number
  inactiveAttempts: number
  dormant: boolean
  mainRunning: boolean
}

const registry = new Map<string, ConversationActor>()
const snapshots = new Map<string, ConversationSnapshot>()
const fleetReconcilers = new Map<string, FleetReconciler>()
const fleetTreeCache = new WeakMap<
  ReadonlyArray<SubagentFleetEvent>,
  { readonly parentPiSessionId: string; readonly tree: SubagentRunTreeContext }
>()
let chatActivities: Record<string, Record<string, SessionActivity>> = {}
const EMPTY_CHAT_ACTIVITIES: Readonly<Record<string, SessionActivity>> = {}
const activityListeners = new Set<() => void>()
/**
 * Previous observation per actor, for the notification edge detector — see
 * `notificationFor`. Held per key (and dropped with the actor) rather than in the
 * subscription closure, because the observation is now made in the flush.
 */
const notifyBaselines = new Map<string, NotifiableState>()
/**
 * File completions are interaction edges, not human-speed status furniture.
 * Keep the newest edge alongside the trailing snapshot so ToolEnd + Done inside
 * one publish window cannot collapse directly to idle and lose the follow event.
 */
const pendingFileActivities = new Map<string, AgentFileActivity>()
const registryKey = (sessionId: string, chatId: string): string =>
  `${sessionId}:${chatId}`

const inactivePiSession = (cause: unknown): boolean =>
  cause instanceof Error && cause.message.toLowerCase().includes("pi session is not active")

const fleetProjection = (snapshot: ConversationSnapshot) => {
  const session = snapshot.context.session
  const chatId = snapshot.context.chatId
  const piSessionId = session.chats.find(({ id }) => id === chatId)?.piSessionId ?? null
  const events = snapshot.context.subagentFleetEvents
  if (piSessionId === null && events.length === 0) return null
  const parentPiSessionId = parentPiSessionIdFromFleetEvents(
    events,
    piSessionId ?? `${session.id}:${chatId}`
  )
  const cached = fleetTreeCache.get(events)
  const tree = cached?.parentPiSessionId === parentPiSessionId
    ? cached.tree
    : projectSubagentFleetEvents(parentPiSessionId, events)
  if (cached?.parentPiSessionId !== parentPiSessionId) {
    fleetTreeCache.set(events, { parentPiSessionId, tree })
  }
  return {
    sessionId: session.id,
    chatId,
    parentPiSessionId,
    tree,
    active: tree.nodes.filter((node) => ACTIVE_FLEET_STATUSES.has(node.status)),
    mainRunning: snapshot.matches("running") || snapshot.matches("remoteRunning")
  }
}

const unknownFleetEvent = (
  node: SubagentFleetNode,
  occurredAt: number,
  registryRevision: number = node.registryRevision
): SubagentFleetEvent => ({
  _tag: "Upsert",
  version: SUBAGENT_FLEET_PROTOCOL_VERSION,
  eventId: `renderer-recovery:unknown:${occurredAt}:${node.id}`,
  occurredAt,
  node: {
    ...node,
    status: "unknown",
    health: "unknown",
    blocking: null,
    terminal: {
      reason: "unknown",
      summary: "Pi session is no longer active",
      at: occurredAt,
      retryable: false
    },
    registryRevision: Math.max(node.registryRevision, registryRevision),
    currentTool: null,
    updatedAt: occurredAt,
    completedAt: occurredAt,
    attention: null
  }
})

export const fleetRecoveryEvents = (
  tree: SubagentRunTreeContext,
  remote: SubagentFleetSnapshot
): ReadonlyArray<SubagentFleetEvent> => {
  if (
    remote.parentPiSessionId !== tree.parentPiSessionId ||
    remote.registryRevision < tree.registryRevision
  ) return []
  const currentById = new Map(tree.nodes.map((node) => [node.id, node]))
  const clocksById = new Map(tree.nodeClocks.map((clock) => [clock.id, clock]))
  const remoteIds = new Set(remote.nodes.map((node) => node.id))
  const recovered: SubagentFleetEvent[] = remote.nodes
    .filter((node) => {
      const existing = currentById.get(node.id)
      if (existing !== undefined) return isSubagentFleetNodeNewer(node, existing)
      const clock = clocksById.get(node.id)
      return clock === undefined || clock.present || clock.registryRevision < node.registryRevision
    })
    .map((node) => ({
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `renderer-recovery:snapshot:${remote.generatedAt}:${node.id}`,
      occurredAt: remote.generatedAt,
      node
    }))
  if (remote.omitted === 0) {
    recovered.push(...tree.nodes
      .filter((node) => {
        const clock = clocksById.get(node.id)
        return ACTIVE_FLEET_STATUSES.has(node.status) &&
          !remoteIds.has(node.id) &&
          (clock?.registryRevision ?? node.registryRevision) <= remote.registryRevision
      })
      .map((node) => unknownFleetEvent(node, remote.generatedAt, remote.registryRevision)))
  }
  return recovered
}

export const fleetRetryDecision = (
  retryAttempt: number,
  inactiveAttempts: number,
  cause: unknown
) => {
  const inactive = inactivePiSession(cause) ? inactiveAttempts + 1 : 0
  if (retryAttempt < 3) {
    return {
      retryAttempt: retryAttempt + 1,
      inactiveAttempts: inactive,
      delay: 250 * (4 ** retryAttempt),
      exhaustedInactive: false
    }
  }
  return {
    retryAttempt: 0,
    inactiveAttempts: 0,
    delay: FLEET_POLL_MS,
    exhaustedInactive: inactive === 4
  }
}

const scheduleFleetReconciliation = (
  key: string,
  state: FleetReconciler,
  delay: number
): void => {
  if (state.timer !== null || state.inFlight || fleetReconcilers.get(key) !== state) return
  state.timer = setTimeout(() => {
    state.timer = null
    void reconcileFleet(key, state)
  }, delay)
}

const recoverInactiveFleet = (
  key: string,
  state: FleetReconciler,
  actor: ConversationActor
): void => {
  const latest = snapshots.get(key)
  const current = latest === undefined ? null : fleetProjection(latest)
  state.dormant = current?.mainRunning !== true
  if (
    !current?.mainRunning &&
    current?.parentPiSessionId === state.parentPiSessionId &&
    current.active.length > 0
  ) {
    actor.send({
      type: "RECOVER_SUBAGENT_FLEET",
      events: current.active.map((node) => unknownFleetEvent(node, Date.now()))
    })
  }
}

const rescheduleFleetReconciliation = (key: string, state: FleetReconciler, nextDelay: number): void => {
  if (registry.has(key) && fleetReconcilers.get(key) === state) {
    scheduleFleetReconciliation(
      key,
      state,
      state.dormant ? FLEET_DORMANT_POLL_MS : nextDelay
    )
  }
}

const reconcileFleet = async (key: string, state: FleetReconciler): Promise<void> => {
  const actor = registry.get(key)
  const projection = snapshots.get(key)
  if (!actor || !projection || fleetReconcilers.get(key) !== state) return
  const before = fleetProjection(projection)
  if (before === null || before.parentPiSessionId !== state.parentPiSessionId) return

  state.inFlight = true
  let nextDelay = FLEET_POLL_MS
  try {
    const remote = await rpc.agentSubagentFleetSnapshot(
      before.sessionId,
      before.chatId,
      before.parentPiSessionId
    )
    const latest = snapshots.get(key)
    const current = latest === undefined ? null : fleetProjection(latest)
    if (!registry.has(key) || current?.parentPiSessionId !== state.parentPiSessionId) return
    const recovered = fleetRecoveryEvents(current.tree, remote)
    if (recovered.length > 0) {
      actor.send({ type: "RECOVER_SUBAGENT_FLEET", events: recovered })
    }
    state.retryAttempt = 0
    state.inactiveAttempts = 0
    state.dormant = remote.totalActive === 0 &&
      remote.omitted === 0 &&
      current.active.length === 0 &&
      !current.mainRunning
  } catch (cause) {
    const retry = fleetRetryDecision(state.retryAttempt, state.inactiveAttempts, cause)
    state.retryAttempt = retry.retryAttempt
    state.inactiveAttempts = retry.inactiveAttempts
    nextDelay = retry.delay
    if (retry.exhaustedInactive) {
      recoverInactiveFleet(key, state, actor)
    }
  } finally {
    state.inFlight = false
    rescheduleFleetReconciliation(key, state, nextDelay)
  }
}

const refreshFleetReconciliation = (
  key: string,
  current: FleetReconciler,
  projection: NonNullable<ReturnType<typeof fleetProjection>>
): void => {
  const mainStarted = !current.mainRunning && projection.mainRunning
  current.mainRunning = projection.mainRunning
  if (current.dormant && (mainStarted || projection.active.length > 0)) {
    if (current.timer !== null) clearTimeout(current.timer)
    current.timer = null
    current.dormant = false
    current.retryAttempt = 0
    current.inactiveAttempts = 0
    scheduleFleetReconciliation(key, current, 0)
  } else {
    scheduleFleetReconciliation(
      key,
      current,
      current.dormant ? FLEET_DORMANT_POLL_MS : FLEET_POLL_MS
    )
  }
}

const ensureFleetReconciliation = (
  key: string,
  snapshot: ConversationSnapshot,
  projection = fleetProjection(snapshot)
): void => {
  const current = fleetReconcilers.get(key)
  if (projection === null) {
    if (current?.timer !== null && current?.timer !== undefined) clearTimeout(current.timer)
    fleetReconcilers.delete(key)
    return
  }
  if (current?.parentPiSessionId === projection.parentPiSessionId) {
    refreshFleetReconciliation(key, current, projection)
    return
  }
  if (current?.timer !== null && current?.timer !== undefined) clearTimeout(current.timer)
  const state: FleetReconciler = {
    parentPiSessionId: projection.parentPiSessionId,
    timer: null,
    inFlight: false,
    retryAttempt: 0,
    inactiveAttempts: 0,
    dormant: false,
    mainRunning: projection.mainRunning
  }
  fleetReconcilers.set(key, state)
  scheduleFleetReconciliation(key, state, 0)
}

const wakeFleetReconcilers = (): void => {
  for (const [key, state] of fleetReconcilers) {
    if (state.inFlight) continue
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    scheduleFleetReconciliation(key, state, 0)
  }
}

if (typeof window !== "undefined") window.addEventListener("focus", wakeFleetReconcilers)
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", wakeFleetReconcilers)
}

/** Where the machine is, in the terms `activityOf` reasons about. */
const phaseOf = (snap: ConversationSnapshot): ActivityPhase => {
  if (snap.matches("running")) return "running"
  // The turn is over — we're either waiting for the halt to land or re-reading
  // the worktree diff. Both are "settling": the sidebar should not claim the
  // agent is still thinking, but nor is the session idle and ready.
  if (snap.matches("stopping") || snap.matches("refreshingDiff")) return "settling"
  return "idle"
}

const agentFileActivityFor = (snap: ConversationSnapshot): AgentFileActivity | null => {
  const phase = phaseOf(snap)
  const fileActivities = [
    agentFileActivityOf(snap.context.messages, phase),
    ...snap.context.subagents.map((subagent) =>
      agentFileActivityOf([subagent.message], phase)
    )
  ].filter((candidate) => candidate !== null)
  return (
    fileActivities.findLast((candidate) => candidate.phase === "editing") ??
    fileActivities.at(-1) ??
    null
  )
}

/**
 * Derive the live activity the sidebar/tab bar show from a machine snapshot.
 * The interesting part lives in `activityOf` (pure, and tested in core) — this
 * only translates machine states into a phase.
 */
const activityFor = (snap: ConversationSnapshot): SessionActivity | null => {
  const activity = activityOf(snap.context.messages, phaseOf(snap), snap.context.subagents)
  return activity === null
    ? null
    : { ...activity, startedAt: snap.context.runStartedAt ?? undefined }
}

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
  for (const [key, snapshot] of snapshots) {
    if (!key.startsWith(`${sessionId}:`)) continue
    // The Plan tab persists for as long as a plan EXISTS — a pending review,
    // a tracked plan file, or a live checklist — not just while a review is
    // open. Approval no longer makes the tab (and the plan) vanish.
    const plannotator = snapshot.context.plannotator
    setPlanPresent(
      key.slice(sessionId.length + 1),
      plannotator !== undefined && plannotator !== null &&
        (plannotator.review !== null ||
          plannotator.planFilePath !== null ||
          plannotator.checklist.length > 0)
    )
  }
  // The diff describes the WORKTREE, which every chat in the session shares —
  // follow the freshest READ, not the most recent publisher. Chats hold their
  // own snapshots of the same diff taken at different times, and last-writer-
  // wins made the session's diff chip flash between two stale readings as the
  // chats took turns publishing.
  let diffSnapshot = preferred
  for (const snapshot of sessionSnapshots) {
    if (
      diffSnapshot === undefined ||
      snapshot.context.patchAt > diffSnapshot.context.patchAt
    ) {
      diffSnapshot = snapshot
    }
  }
  if (diffSnapshot === undefined) clearSessionDiff(sessionId)
  else setSessionDiff(sessionId, diffSnapshot.context.diffStat)
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
  const fleet = fleetProjection(snap)
  ensureFleetReconciliation(key, snap, fleet)
  const legacyAgents = snap.context.reviewer === null
    ? snap.context.subagents
    : [...snap.context.subagents, snap.context.reviewer]
  publishActorSubagentTabs(
    session.id,
    projectSubagentTabs({
      sessionId: session.id,
      chatId,
      piSessionId: session.chats.find(({ id }) => id === chatId)?.piSessionId ?? null,
      events: snap.context.subagentFleetEvents,
      legacyAgents,
      canonicalNodes: fleet?.tree.nodes
    })
  )
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

  publishChatActivity(session.id, chatId, activity)
  const currentFile = agentFileActivityFor(snap)
  const pendingFile = pendingFileActivities.get(key) ?? null
  pendingFileActivities.delete(key)
  // A completed mutation may be followed by Done before the trailing publisher
  // runs. Deliver that edge once, then enqueue the same idle snapshot so the
  // external store clears on the next window and cannot replay stale activity.
  const preservedCompletion =
    currentFile === null && pendingFile?.phase === "completed" ? pendingFile : null
  const activeFile = currentFile ?? preservedCompletion
  publishAgentFileActivity(session.id, chatId, activeFile)
  if (preservedCompletion !== null) publishes.push(key, snap)
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
  if (registry.size > MAX_LIVE_ACTORS) evictIdleActors("")
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

/**
 * Stop + forget one actor, leaving the SESSION-level stores it published alone
 * (see `evictIdleActors` for why) but clearing its CHAT-scoped entries. Those
 * used to be dropped only on explicit chat/session deletion, so every chat
 * ever opened kept its last activity + file-activity object resident for the
 * app's lifetime; like the transcript, they are recomputed when the chat is
 * next opened.
 */
const forget = (key: string): void => {
  const reconciler = fleetReconcilers.get(key)
  if (reconciler?.timer !== null && reconciler?.timer !== undefined) clearTimeout(reconciler.timer)
  fleetReconcilers.delete(key)
  registry.get(key)?.stop()
  registry.delete(key)
  snapshots.delete(key)
  notifyBaselines.delete(key)
  pendingFileActivities.delete(key)
  publishes.cancel(key)
  const separator = key.indexOf(":")
  if (separator === -1) return
  const sessionId = key.slice(0, separator)
  const chatId = key.slice(separator + 1)
  publishChatActivity(sessionId, chatId, null)
  clearAgentFileActivityChat(sessionId, chatId)
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
            phase:
              (fleetProjection(snapshot)?.active.length ?? 0) > 0
                ? "running"
                : phaseOf(snapshot),
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
/**
 * Dev-only observability accessor for the perf monitor (perf-hook.ts). The
 * registry map is module-private on purpose; this exposes only its SIZE — a
 * count above MAX_LIVE_ACTORS + visible panes means eviction has stopped
 * working, which historically was a multi-GB leak.
 */
export const __debugActorCount = (): number => registry.size

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
    const fileActivity = agentFileActivityFor(snap)
    if (fileActivity !== null) pendingFileActivities.set(key, fileActivity)
    publishes.push(key, snap)
  })
  actor.start()
  registry.set(key, actor)
  // The coalesced publish evicts after React commits visibility. Evicting during
  // render can stop a sibling in the session that is still being mounted.
  return actor
}

/** Stop + forget a session's actor (call when the session is deleted). */
export const disposeConversationActor = (sessionId: string): void => {
  clearSubagentTabs(sessionId)
  for (const key of [...registry.keys()]) {
    if (!key.startsWith(`${sessionId}:`)) continue
    setPlanPresent(key.slice(sessionId.length + 1), false)
    forget(key)
  }
  delete chatActivities[sessionId]
  clearAgentFileActivitySession(sessionId)
  setSessionActivity(sessionId, null)
  clearSessionDiff(sessionId)
}

export const disposeChatActor = (sessionId: string, chatId: string): void => {
  const key = registryKey(sessionId, chatId)
  setPlanPresent(chatId, false)
  forget(key)
  clearAgentFileActivityChat(sessionId, chatId)
  publishChatActivity(sessionId, chatId, null)
  recomputeSession(sessionId)
}
