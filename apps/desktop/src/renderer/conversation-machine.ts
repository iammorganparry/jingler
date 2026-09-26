/**
 * Deterministic conversation flow as an XState chart — mirrors `app-machine.ts`.
 * Loading the transcript, streaming a turn, and pausing at a gate are modelled as
 * states/actors, so there are no data-fetching `useEffect`s: the machine is
 * spawned fresh per session (the view keys it by session id) and drives itself.
 *
 * The agent stream is an invoked `fromCallback` actor that forwards each
 * normalized `StreamEvent` back as a `STREAM_EVENT`; the machine folds it into
 * the transcript with the same `applyStreamEvent` the main process persists with.
 */
import type {
  AgentEndpointId,
  AgentRuntimeId,
  Attachment,
  ContextBreakdown,
  ExecutionMode,
  ExternalInstructionIdentity,
  GateDecision,
  Message,
  PermissionMode,
  Plan,
  PlannotatorProjection,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  QuestionAnswer,
  ReasoningSetting,
  ReviewPhase,
  Session,
  SessionEventCursor,
  SessionEventEnvelope,
  SessionStatus,
  SettledSessionStatus,
  Skill,
  StreamEvent,
  Subagent,
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import {
  activityOf,
  admitSessionEvent,
  applyReviewEvent,
  applyStreamEvent,
  applySubagentEvent,
  assistantMessage,
  isFileMutationTool,
  nextReviewPhase,
  planDocumentToPlan,
  isSubagentEvent,
  retractSubagent,
  setGateStatus,
  setQuestionAnswers,
  settleLoaded,
  settleStreaming,
  STOPPED_NOTE,
  userMessage
} from "@jingler/core"
import type { SessionDiffStat } from "@jingler/contracts"
import {
  assign,
  fromCallback,
  fromPromise,
  raise,
  setup,
  spawnChild,
  stopChild
} from "xstate"
import { rpc } from "./rpc-client.js"

const modelMutations = new Map<string, { generation: number; tail: Promise<void> }>()

/**
 * How long the composer waits for a model switch to persist. Main gives up at
 * 10s with a reason; this is the backstop for a reply that never arrives at
 * all, which would otherwise leave "Saving the selected agent runtime…" up
 * forever and every later switch queued behind it.
 */
export const MODEL_PERSIST_TIMEOUT_MS = 20_000

const withTimeout = <A>(run: () => Promise<A>, ms: number) => (): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Model switch timed out")), ms)
    run().then(resolve, reject).finally(() => clearTimeout(timer))
  })

export const persistModelSelection = (
  key: string,
  run: () => Promise<Session>,
  onSuccess: (session: Session) => void,
  onLatestFailure: () => void,
  timeoutMs = MODEL_PERSIST_TIMEOUT_MS
): void => {
  const current = modelMutations.get(key)
  const generation = (current?.generation ?? 0) + 1
  const bounded = withTimeout(run, timeoutMs)
  const started = current === undefined
    ? bounded()
    : current.tail.catch(() => undefined).then(bounded)
  const request = started.then((session) => {
    if (modelMutations.get(key)?.generation === generation) onSuccess(session)
  })
    .catch(() => {
      if (modelMutations.get(key)?.generation === generation) onLatestFailure()
    })
    .finally(() => {
      if (modelMutations.get(key)?.generation === generation) modelMutations.delete(key)
    })
  modelMutations.set(key, { generation, tail: request })
}
import { completedSubagentNodes } from "./subagent-tab-store.js"
import { compactMessageParts, compactMessages } from "./transcript-compaction.js"

/**
 * Force a compaction pass after this many folded stream events even if no
 * `ToolEnd` arrived. Compaction is reference-preserving and idempotent, so a
 * due pass that finds nothing to release is nearly free; the counter only
 * bounds how many deltas can accumulate unexamined.
 */
const COMPACT_EVERY_N_FOLDS = 300
const MAX_FLEET_EVENTS = 512
const ACTIVE_FLEET_STATUSES: ReadonlySet<SubagentFleetNode["status"]> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])
const COMPLETED_FLEET_STATUSES: ReadonlySet<SubagentFleetNode["status"]> = new Set([
  "completed",
  "failed",
  "stopped",
  "unknown"
])

export const boundedFleetEvents = (
  events: ReadonlyArray<SubagentFleetEvent>
): ReadonlyArray<SubagentFleetEvent> => {
  if (events.length <= MAX_FLEET_EVENTS) return events
  const parentRuntimeSessionId = parentRuntimeSessionIdFromFleetEvents(events, "")
  const tombstones = new Map<string, Extract<SubagentFleetEvent, { _tag: "Remove" }>>()
  let latestSnapshot: Extract<SubagentFleetEvent, { _tag: "Snapshot" }> | null = null
  const terminalIds = new Set<string>()
  for (const event of events) {
    if (event._tag === "Remove") {
      recordFleetTombstone(tombstones, event, parentRuntimeSessionId)
      continue
    }
    if (event._tag === "Snapshot" && event.snapshot.parentRuntimeSessionId === parentRuntimeSessionId) {
      if (isNewerFleetSnapshot(event, latestSnapshot)) latestSnapshot = event
    }
    const nodes = fleetNodesForParent(event, parentRuntimeSessionId)
    recordTerminalFleetIds(terminalIds, nodes)
  }

  const activeNodes = parentRuntimeSessionId === ""
    ? []
    : projectSubagentFleetEvents(parentRuntimeSessionId, events).nodes.filter((node) =>
        ACTIVE_FLEET_STATUSES.has(node.status)
      )
  const activeIds = new Set(activeNodes.map((node) => node.id))
  const activeEvents = activeNodes.map((node): SubagentFleetEvent => ({
    _tag: "Upsert",
    version: 2,
    eventId: `compact:${node.registryRevision}:${node.childSequence}:${node.id}`,
    occurredAt: node.updatedAt,
    node
  }))
  const parentEvents = events.filter((event) =>
    event._tag === "Upsert"
      ? event.node.parentRuntimeSessionId === parentRuntimeSessionId
      : event._tag === "Snapshot"
        ? event.snapshot.parentRuntimeSessionId === parentRuntimeSessionId
        : event.id.startsWith(`${parentRuntimeSessionId}/`)
  )
  const terminalEvents = completedSubagentNodes(parentEvents)
    .map((node): SubagentFleetEvent => ({
      _tag: "Upsert",
      version: 2,
      eventId: `compact:terminal:${node.registryRevision}:${node.childSequence}:${node.id}`,
      occurredAt: node.completedAt ?? node.updatedAt,
      node
    }))
  const metadataSnapshot: ReadonlyArray<SubagentFleetEvent> = latestSnapshot === null
    ? []
    : [{
        ...latestSnapshot,
        eventId: `compact:snapshot:${latestSnapshot.snapshot.registryRevision}`,
        snapshot: {
          ...latestSnapshot.snapshot,
          omitted: Math.max(1, latestSnapshot.snapshot.omitted),
          nodes: []
        }
      }]
  // ponytail: 64 records covers the 8 live nodes plus the Previous chats window.
  const historySlots = Math.max(
    0,
    64 - metadataSnapshot.length - activeEvents.length - terminalEvents.length
  )
  const history = historySlots === 0
    ? []
    : events
        .filter((event) =>
          event._tag === "Upsert" &&
          event.node.parentRuntimeSessionId === parentRuntimeSessionId &&
          !activeIds.has(event.node.id) &&
          !terminalIds.has(event.node.id)
        )
        .slice(-historySlots)
  const retained = [...metadataSnapshot, ...history, ...terminalEvents, ...activeEvents]
  const protectedIds = new Set(retained.flatMap((event) =>
    event._tag === "Upsert" ? [event.node.id] : []
  ))
  const removeSlots = MAX_FLEET_EVENTS - retained.length
  const required = [...protectedIds]
    .map((id) => tombstones.get(id))
    .filter((event) => event !== undefined)
    .slice(-removeSlots)
  const requiredIds = new Set(required.map((event) => event.id))
  const optionalSlots = removeSlots - required.length
  const optional = optionalSlots <= 0
    ? []
    : [...tombstones.values()]
        .filter((event) => !requiredIds.has(event.id))
        .slice(-optionalSlots)
  return [...retained, ...optional, ...required]
}

import { publishSessionUpdate } from "./session-updates.js"
import {
  parentRuntimeSessionIdFromFleetEvents,
  projectSubagentFleetEvents,
  settleStoppedFleet
} from "./subagent-fleet-machine.js"

const isExecutionMode = (mode: PermissionMode): mode is ExecutionMode =>
  mode !== "plan"

/** Optimistic mirror of SessionStore.setProviderModel while its RPC persists. */
const withProviderModel = (
  session: Session,
  chatId: string,
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  connectionId: ProviderConnectionId | undefined,
  providerId: ProviderId,
  modelId: ProviderModelId
): Session => {
  const current = session.chats.find((chat) => chat.id === chatId)
  const endpointChanged =
    current?.runtimeId !== runtimeId || current?.endpointId !== endpointId
  const nextConnectionId = connectionId ?? (
    endpointChanged ? undefined : current?.connectionId
  )
  const changed =
    endpointChanged ||
    current?.connectionId !== nextConnectionId ||
    current?.providerId !== providerId ||
    current?.modelId !== modelId
  return {
    ...session,
    runtimeId,
    endpointId,
    connectionId: nextConnectionId,
    providerId,
    modelId,
    ...(endpointChanged ? { continuation: undefined } : {}),
    connectionSelectionRequired: false,
    modelSelectionRequired: false,
    chats: session.chats.map((chat) =>
      chat.id !== chatId
        ? chat
        : {
            ...chat,
            runtimeId,
            endpointId,
            connectionId: nextConnectionId,
            providerId,
            modelId,
            ...(endpointChanged ? { continuation: undefined } : {}),
            connectionSelectionRequired: false,
            modelSelectionRequired: false,
            ...(changed ? { reasoning: undefined } : {})
          }
    )
  }
}

const toolNameInMessage = (message: Message, id: string): string | null => {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]!
    if (part._tag === "Tool" && part.tool.id === id) return part.tool.name
  }
  return null
}

/** Resolve a ToolEnd back to its ToolStart, including sub-agent transcripts. */
const toolNameFor = (
  context: ConversationContext,
  id: string,
  agentId?: string
): string | null => {
  if (agentId !== undefined) {
    const agent = context.subagents.find((candidate) => candidate.id === agentId)
    return agent ? toolNameInMessage(agent.message, id) : null
  }
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const name = toolNameInMessage(context.messages[i]!, id)
    if (name !== null) return name
  }
  return null
}

export interface ConversationContext {
  readonly session: Session
  readonly chatId: string
  readonly messages: ReadonlyArray<Message>
  /** Ordered remote-event fence; local STREAM_EVENT delivery bypasses it unchanged. */
  readonly sessionEventCursor: SessionEventCursor
  readonly remotePublishProgress: {
    readonly phase: "inspecting" | "preparing" | "publishing" | "complete"
    readonly message: string
  } | null
  readonly mode: PermissionMode
  /** Last concrete harness permission mode, retained while Plan is selected. */
  readonly executionMode: ExecutionMode
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  readonly runtimeId: AgentRuntimeId | null
  readonly endpointId: AgentEndpointId | null
  readonly connectionId: ProviderConnectionId | null
  readonly providerId: ProviderId | null
  readonly modelId: ProviderModelId | null
  readonly modelPending: boolean
  /** Lightweight worktree totals for the Changes rail. */
  readonly diffStat: SessionDiffStat
  /**
   * When `diffStat` was last read (epoch ms; 0 = never). Chats in one session
   * each hold their own snapshot of the SAME worktree's diff, taken at
   * different times — the session-level diff chip must follow the freshest
   * one, not whichever chat happened to publish last (that alternated the
   * chip between two stale readings).
   */
  readonly patchAt: number
  /** Operator-visible text for the running turn. */
  readonly pendingText: string
  /** Hidden structured context appended only when the harness is dispatched. */
  readonly pendingAgentContext: string
  /** Images attached to the turn currently running (sent to the harness). */
  readonly pendingImages: ReadonlyArray<Attachment>
  /** Stable source for the running external turn, when this is not a composer send. */
  readonly pendingExternalInstruction: ExternalInstructionIdentity | null
  /** Every coalesced delivery waiter resolves only after main durably accepts the turn. */
  readonly pendingExternalAcceptances: ReadonlyArray<() => void>
  /** Provider-native thinking state for the next and subsequent turns. */
  readonly reasoning?: ReasoningSetting
  /**
   * Messages the operator sent while the agent was busy — held FIFO and sent, one
   * turn at a time, as soon as the current run (and its diff refresh) settles.
   */
  readonly queued: ReadonlyArray<QueuedMessage>
  /** Prevents two rapid Send-now clicks from racing native steer responses. */
  /**
   * The id of the queued message whose steer is in flight, or null.
   *
   * An id rather than a flag because the row is still on screen while this is
   * set, and it is no longer a QUEUED message: the agent has been given it and
   * the reply is on its way back. Offering "hand off" or "remove" on it would run
   * the same prompt a second time, so the view needs to know WHICH row that is,
   * not merely that some steer is pending.
   */
  readonly steeringId: string | null
  /**
   * True after the operator pressed Stop with messages still queued.
   *
   * Stop used to CLEAR the queue, which silently destroyed exactly the messages
   * the machine itself refuses to steer (hidden code-reference context and
   * external feedback must dequeue through Agent.run, so they are the ones most
   * likely to still be queued when the operator halts the turn). Parking keeps
   * the rows on screen and inert: nothing auto-runs or auto-flushes until the
   * operator acts on a row ("Send now") or sends something new — halting stays
   * halting, and nothing typed is lost.
   */
  readonly queueParked: boolean
  /**
   * Live sub-agents (harness `Task` spawns) for the current turn — each a
   * watch-only tab. Populated from `agentId`-tagged + `Subagent*` events, dropped
   * when an agent finishes; never persisted (transcripts.json holds the main turn).
   */
  readonly subagents: ReadonlyArray<Subagent>
  /** Bounded first-class pi-subagents lifecycle feed for the per-chat Fleet actor. */
  readonly subagentFleetEvents: ReadonlyArray<SubagentFleetEvent>
  readonly subagentControlOutcomes: ReadonlyArray<SubagentFleetControlOutcome>
  /**
   * Stream events folded since the last compaction pass. Compaction normally
   * runs at `ToolEnd`, but a turn that streams long reasoning (Thinking deltas
   * merge into ONE part) or one long tool's deltas can go arbitrarily long
   * without a ToolEnd — this counter forces a pass every
   * `COMPACT_EVERY_N_FOLDS` events so a never-settling turn stays bounded.
   */
  readonly foldsSinceCompaction: number
  readonly sharedPlanChatId: string | null
  /** Canonical plan projected over every transcript page as it is loaded. */
  readonly sharedPlan: Plan | null
  /** Disposable native projection of Plannotator's authoritative state. */
  readonly plannotator?: PlannotatorProjection
  /** Tokens currently occupying the main agent's context window. */
  readonly tokens: number
  readonly contextBreakdown: ContextBreakdown | null
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  readonly runStartedAt: number | null
  /**
   * How the most recent run ENDED, or null while one is in flight.
   *
   * A `Failed` folds into the transcript as ordinary text (see the fold), so by
   * the time an observer sees the settled messages it can no longer tell a
   * failure from a normal reply. The notifier needs that distinction — "your
   * agent finished" and "your agent died" are not interchangeable — so the fold
   * records it here rather than making every observer re-derive it.
   */
  readonly lastOutcome: "done" | "failed" | null
  /**
   * The last lifecycle status known to be in the store, so a settling turn only
   * hits the disk when the status actually CHANGED (sessions.json is rewritten
   * whole on every write). Seeded from the loaded session, so it's the full
   * `SessionStatus`; only a `SettledSessionStatus` is ever written.
   */
  readonly persistedStatus: SessionStatus
  /**
   * Whether the transcript actually loaded. False after a load failure, where
   * `messages` is empty through no fault of the session — status must not be
   * derived from it (see `persistSettledStatus`).
   */
  readonly loaded: boolean
  /**
   * Whether older turns remain on disk before `messages[0]` — the "Load earlier"
   * affordance's gate. A session opens with only its tail (see `HISTORY_PAGE_SIZE`).
   */
  readonly hasMoreHistory: boolean
  /** Opaque store position for the next older page. */
  readonly historyCursor: string | null
  /** An older-page fetch is in flight; blocks a second and shows the spinner. */
  readonly loadingHistory: boolean
  /** Review progress lives outside an individual harness turn. */
  readonly reviewer: Subagent | null
  /** Where the running review has got to — the PR button's label. */
  readonly reviewPhase: ReviewPhase
  /** Epoch ms the review started, or null when no review is running. */
  readonly reviewStartedAt: number | null
}

/** A prompt held while busy. */
export interface QueuedMessage {
  /**
   * Stable for the message's whole life in the queue — the ONLY safe way to
   * address a row.
   *
   * The queue used to shrink only between turns, so a position was as good as an
   * identity. It now shrinks mid-run, at a moment nothing on screen predicts: the
   * automatic flush removes the head whenever the agent hits a tool boundary. A
   * click carrying a render-time index then lands one row off — the operator
   * deletes a message they meant to keep. Object identity is no better, because
   * an edit replaces the object.
   */
  readonly id: string
  readonly text: string
  /** Structured context stays out of the editable queued-row text. */
  readonly agentContext: string
  readonly images: ReadonlyArray<Attachment>
  readonly externalInstruction?: ExternalInstructionIdentity
  readonly externalAcceptances: ReadonlyArray<() => void>
}

/**
 * Some queued turns need the durable Agent.run boundary. Native steering cannot
 * persist a different operator-visible value from the harness prompt, so hidden
 * code-reference context must not take that path. Relay feedback also needs
 * Agent.run to atomically accept the identity that makes replay idempotent.
 *
 * Check both fields defensively. They are created together today, but treating
 * either one as external prevents a future partial mapping from silently
 * resolving an acknowledgement through the non-durable steer path.
 */
const requiresFreshTurn = (queued: QueuedMessage): boolean =>
  queued.agentContext !== "" ||
  queued.externalInstruction !== undefined ||
  queued.externalAcceptances.length > 0

const agentPrompt = (text: string, context: string): string =>
  context === "" ? text : text === "" ? context : `${text}\n\n${context}`

type SteerResult =
  | { readonly status: "accepted"; readonly user: Message; readonly assistant: Message }
  | { readonly status: "deferred" | "unsupported" }

type ConversationEvent =
  | {
      type: "SEND"
      text: string
      images?: ReadonlyArray<Attachment>
      agentContext?: string
      externalInstruction?: ExternalInstructionIdentity
      onExternalAccepted?: () => void
    }
  // Addressed by id, never by position — see `QueuedMessage.id`.
  | { type: "UNQUEUE"; id: string }
  | { type: "SEND_NOW"; id: string }
  | { type: "EDIT_QUEUED"; id: string; text: string }
  /**
   * A steer came back. `auto` marks the queue's own tool-boundary flush, which
   * must NEVER fall back to stop-and-replay: the operator did not ask for an
   * interruption, so an unsupported/failed auto-flush leaves the message queued.
   */
  | { type: "STEER_RESULT"; queued: QueuedMessage; result: SteerResult; auto?: boolean }
  | { type: "STREAM_EVENT"; event: StreamEvent }
  | { type: "RECOVER_SUBAGENT_FLEET"; events: ReadonlyArray<SubagentFleetEvent> }
  | { type: "SESSION_EVENT_ENVELOPE"; envelope: SessionEventEnvelope }
  | { type: "DIFF_STAT_UPDATED"; diffStat: SessionDiffStat }
  | { type: "FILES_UPDATED"; files: ReadonlyArray<string> }
  | { type: "DECIDE_GATE"; gateId: string; decision: GateDecision }
  | { type: "ANSWER_QUESTION"; requestId: string; answers: ReadonlyArray<QuestionAnswer> }
  | { type: "SET_MODE"; mode: PermissionMode }
  | {
      type: "SET_MODEL"
      runtimeId: AgentRuntimeId
      endpointId: AgentEndpointId
      connectionId?: ProviderConnectionId
      providerId: ProviderId
      modelId: ProviderModelId
    }
  | { type: "SET_REASONING"; reasoning?: ReasoningSetting }
  | { type: "MODEL_PERSISTED"; session: Session }
  | { type: "MODEL_PERSIST_FAILED"; session: Session }
  | { type: "SESSION_UPDATED"; session: Session }
  | {
      type: "WORKSPACE_META_LOADED"
      files: ReadonlyArray<string>
      diffStat: SessionDiffStat
    }
  | { type: "SHARED_PLAN_UPDATED"; plan: Plan; producingChatId: string }
  | { type: "SKILLS_LOADED"; skills: ReadonlyArray<Skill> }
  | { type: "REVIEW_EVENT"; event: StreamEvent }
  | { type: "REFRESH_DIFF" }
  | { type: "STOP" }
  /** Kill ONE live sub-agent (its tab's ×), leaving the turn running. */
  | { type: "STOP_SUBAGENT"; agentId: string }
  /** Drop a SETTLED sub-agent's tab. Local only — nothing to tell the harness. */
  | { type: "CLOSE_SUBAGENT"; agentId: string }
  /** "Load earlier": page the next window of older turns onto the front. */
  | { type: "LOAD_OLDER" }
  /** One older page came back — prepend it, or clear the spinner on failure. */
  | {
      type: "HISTORY_LOADED"
      messages: ReadonlyArray<Message>
      hasMore: boolean
      cursor: string | null
    }
  /** The re-read tail for an over-cap live array — REPLACES `messages`, never prepends. */
  | {
      type: "HISTORY_TRIMMED"
      messages: ReadonlyArray<Message>
      hasMore: boolean
      cursor: string | null
    }

/**
 * How many messages a page holds — both the tail loaded on open and each older
 * page fetched by "Load earlier". Big enough that most sessions open whole and
 * the button never appears; small enough that a 46MB transcript no longer lands
 * in the renderer as one parsed array (the memory this windowing exists to save).
 */
const HISTORY_PAGE_SIZE = 200

/**
 * When the resident live array is re-windowed from disk.
 *
 * A settled turn's messages are never dropped in flight, so a session whose
 * actor stays alive (the residency cap keeps a busy background session running)
 * grows without bound in message COUNT — bytes-per-message are separately
 * bounded by `transcript-compaction.ts`. Past this cap the tail is re-read from
 * disk and the head dropped; see `trimmedTailState` and `requestHistoryTrim`,
 * fired from both settled turn boundaries (`awaitingInput` and
 * `refreshingDiff`, the latter covering back-to-back queued turns that never
 * go idle).
 *
 * 2× the page size, not 1×: an ordinary back-and-forth must never trip it, so
 * the trim fires only on genuinely long-lived sessions, and the operator keeps a
 * generous on-screen window either side of the boundary.
 */
export const LIVE_HISTORY_CAP = 2 * HISTORY_PAGE_SIZE

/** Whether the live array has grown far enough past its window to re-window it. */
export const shouldTrimLiveHistory = (
  messageCount: number,
  cap: number = LIVE_HISTORY_CAP
): boolean => messageCount > cap

const projectLoadedPlan = (
  messages: ReadonlyArray<Message>,
  plan: Plan | null
): { readonly messages: ReadonlyArray<Message>; readonly grafted: boolean } => {
  let grafted = false
  const projected = messages.map((message) => {
    const base = settleLoaded(message)
    if (plan === null) return base
    const carriesPlan = base.parts.some(
      (part) => part._tag === "Plan" && part.plan.id === plan.id
    )
    if (!carriesPlan) return base
    grafted = true
    return {
      ...base,
      parts: base.parts.map((part) =>
        part._tag === "Plan" && part.plan.id === plan.id
          ? { _tag: "Plan" as const, plan }
          : part
      )
    }
  })
  return { messages: projected, grafted }
}

/**
 * One cancellable history request. Unlike a Promise launched from `assign`, the
 * child is stopped with its owning conversation and ignores a late RPC reply.
 */
const historyPage = fromCallback<
  ConversationEvent,
  { sessionId: string; chatId: string; before: string }
>(({ input, sendBack }) => {
  let active = true
  void rpc
    .sessionsTranscriptPage(
      input.sessionId,
      input.chatId,
      input.before,
      HISTORY_PAGE_SIZE
    )
    .then((page) => {
      if (!active) return
      sendBack({
        type: "HISTORY_LOADED",
        messages: page.messages,
        hasMore: page.hasMore,
        cursor: page.cursor ?? null
      })
    })
    .catch(() => {
      if (!active) return
      sendBack({
        type: "HISTORY_LOADED",
        messages: [],
        hasMore: true,
        cursor: input.before
      })
    })
  return () => {
    active = false
  }
})

interface LoadedData {
  readonly transcript: ReadonlyArray<Message>
  readonly sharedPlanChatId: string | null
  readonly sharedPlan: Plan | null
  /** Whether older turns remain on disk before the loaded tail. */
  readonly hasMore: boolean
  readonly cursor: string | null
  /**
   * Whether main reports a live, unsettled turn for this chat RIGHT NOW.
   *
   * A renderer reload resets this machine while main's turn keeps streaming.
   * Dequeuing a held message straight into Agent.run then hits the runner's
   * single-flight refusal, and the message's only "reply" is the refusal text.
   * When busy, the load parks in `awaitingInput` instead; the live turn's
   * envelopes re-attach the view and the queue drains at the turn boundary.
   */
  readonly busy: boolean
}

export const CONVERSATION_LOAD_TIMEOUT_MS = 30_000

const withLoadDeadline = <Value>(operation: Promise<Value>): Promise<Value> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out loading the conversation.")),
      CONVERSATION_LOAD_TIMEOUT_MS
    )
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    )
  })

/**
 * Load the persisted transcript, worktree files + diff.
 *
 * Skills are NOT here, deliberately — they are fetched out of band (see
 * `loadSkills`), exactly like the model catalogue. `Skills.list` asks the
 * harness itself what commands it has, which means spawning it: hundreds of ms
 * to seconds. `loading` handles almost no events, so gating the transcript on a
 * CLI probe silently swallows everything the operator does in that window —
 * including SEND, which is to say the composer looks alive but does nothing.
 * The `/` menu just fills itself in a beat later.
 */
const loadConversation = fromPromise<
  LoadedData,
  { session: Session; chatId: string }
>(async ({ input }) => {
  // ONLY what the transcript's first paint needs: the tail page, and the plan
  // artifact its graft depends on. The worktree file list and diff used to sit
  // in this same join, which gated first paint on a repo walk + a git diff —
  // the two tail-latency drivers on a big repo. They now load out of band
  // (`loadWorkspaceMeta`) and land whenever they land.
  const [page, artifact] = await withLoadDeadline(Promise.all([
    // Only the tail — older turns page in via LOAD_OLDER. A whole 46MB
    // transcript held as one parsed array was the renderer's high-water mark.
    rpc.sessionsTranscriptPage(input.session.id, input.chatId, undefined, HISTORY_PAGE_SIZE),
    rpc.planCurrent(input.session.id, input.chatId)
  ]))
  const rawTranscript = page.messages
  // A loaded transcript has no live run — settle any turn left mid-stream (the
  // app was closed mid-response) so it doesn't show the typing indicator forever,
  // and resolve orphaned approval gates / questions whose live run has died (their
  // approve/deny buttons would otherwise be dead no-ops). The shared plan document
  // is projected from canonical MDX and grafted over its stale transcript copy in
  // the same walk.
  //
  // ONE pass, deliberately. This runs on every actor start — which includes every
  // re-open after the residency cap evicted a session — and the transcripts it
  // walks reach 44MB on disk. The shape this replaces settled with one `map`,
  // grafted the artifact with a SECOND `map` that spread every message and rebuilt
  // every `parts` array (when at most one message holds that plan), then scanned
  // the result a third time to ask whether the graft had landed. Two of those
  // three walks copied the whole object graph for the sake of a single part.
  //
  // That cost more than the wasted work suggests, because it is a PEAK and peaks
  // here are permanent: neither V8 nor PartitionAlloc hand a spike's pages back to
  // the OS, so the renderer's footprint became a high-water mark of transcript
  // loads rather than a measure of what it was holding — 3.6GB of process against
  // 127MB of live JS heap and 1,149 DOM nodes.
  //
  // So a message is passed through BY REFERENCE unless it actually carries the
  // artifact's plan, and whether the graft landed is observed during the walk
  // rather than by re-scanning after it.
  const projectedPlan = artifact === null ? null : planDocumentToPlan(artifact)
  const { messages: settled, grafted } = projectLoadedPlan(
    rawTranscript,
    projectedPlan
  )
  const transcript =
    artifact === null || grafted
      ? settled
      : [
          ...settled,
          {
            ...applyStreamEvent(
              assistantMessage(
                `a_shared_plan_${artifact.revision}`,
                artifact.updatedAt
              ),
              { _tag: "PlanProposed", plan: projectedPlan! }
            ),
            streaming: false
          }
        ]
  // Best-effort: an errored probe must not fail the whole load, and "not busy"
  // is the safe default — it restores exactly the pre-probe behaviour.
  const busy = await rpc
    .agentChatBusy(input.session.id, input.chatId)
    .catch(() => false)
  return {
    transcript,
    sharedPlanChatId: artifact?.producingChatId ?? null,
    sharedPlan: projectedPlan,
    hasMore: page.hasMore,
    cursor: page.cursor ?? null,
    busy
  }
})

/** Re-read worktree totals after a turn completes (edits may have landed). */
const refreshDiff = fromPromise<SessionDiffStat, { session: Session }>(({ input }) =>
  rpc.sessionsDiffStat(input.session.id)
)

/**
 * Halt the current run, and WAIT for the halt to land.
 *
 * Firing this and moving on is what used to eat the operator's next message.
 * `agentStop` interrupts the run's fiber, but the runner keyed that fiber by
 * session id alone — so if the next turn had already started, the interrupt
 * found the NEW run and killed it. The operator's fresh message came back as a
 * bare "Stopped." and they re-sent it, usually within five seconds.
 *
 * The runner now serialises stop against a turn's setup, so this await is the
 * belt to that braces: waiting here means the next run is not merely
 * unkillable-by-mistake, it does not exist yet.
 */
const stopAgent = fromPromise<void, { sessionId: string; chatId: string }>(({ input }) =>
  rpc.agentStop(input.sessionId, input.chatId)
)

/**
 * How long we wait for a stop to land before starting the next turn anyway.
 *
 * A harness can take real time to tear a child down, and an operator who hit
 * "send now" is asking for the next turn, not for a progress bar. Past the cap
 * we proceed: the runner's own lock still orders the two runs correctly, so the
 * cost of being early here is a slower first token, not a lost turn.
 */
const STOP_SETTLE_CAP = 3_000

/** Subscribe to the agent's event stream, forwarding each event into the machine. */
const agentStream = fromCallback<
  ConversationEvent,
  {
    sessionId: string
    chatId: string
    text: string
    displayText: string
    images: ReadonlyArray<Attachment>
    reasoning?: ReasoningSetting
    externalInstruction: ExternalInstructionIdentity | null
  }
>(({ sendBack, input }) => {
  const onEvent = (event: StreamEvent) => sendBack({ type: "STREAM_EVENT", event })
  const cancel = rpc.agentRun(input.sessionId, input.chatId, input.text, onEvent, input.images, {
    displayText: input.displayText,
    reasoning: input.reasoning ?? null,
    ...(input.externalInstruction === null
      ? {}
      : { externalInstruction: input.externalInstruction })
  })
  return cancel
})

/**
 * Watch review progress for this session for the whole life of the machine.
 *
 * Always-on because the reviewer is usually not started from here: the PR tab's
 * button fires it, and the background auto-review poll can start one for a
 * session nobody is looking at. Subscribing costs nothing while idle (the stream
 * stays quiet until a review starts) and means the Reviewer tab is live the
 * moment one does.
 *
 * Scoped to THIS chat, not just the session. A review is a session-level
 * artifact, but every chat runs its own conversation machine and renders the
 * reviewer in its own sub-agent rail — so a session-wide watch would replay one
 * chat's review into all of them, and a brand-new chat would open showing a
 * Reviewer tab for a run it had no part in. Passing `chatId` lets the watch
 * receive only the review THIS chat owns (the chat that was active when the
 * review started); the others stay silent.
 */
const reviewStream = fromCallback<ConversationEvent, { sessionId: string; chatId: string }>(
  ({ sendBack, input }) =>
    rpc.reviewWatch(input.sessionId, input.chatId, (event) =>
      sendBack({ type: "REVIEW_EVENT", event })
    )
)

const patchLast = (
  messages: ReadonlyArray<Message>,
  fn: (last: Message) => Message
): ReadonlyArray<Message> =>
  messages.length === 0 ? messages : [...messages.slice(0, -1), fn(messages[messages.length - 1]!)]

const gateStatusFor = (decision: GateDecision) =>
  decision === "deny" ? "rejected" : decision === "always" ? "always" : "approved"

const stamp = () => Date.now().toString(36)

const sameExternalInstruction = (
  left: ExternalInstructionIdentity | undefined | null,
  right: ExternalInstructionIdentity
): boolean =>
  left?.deliveryId === right.deliveryId || left?.semanticKey === right.semanticKey

/**
 * Hand a queued message to the live turn, and report back as `STEER_RESULT`.
 *
 * Shared by the operator's "Send now" and the queue's automatic flush, which
 * differ in exactly two ways — and both differences are about what happens when
 * the harness CANNOT take the message:
 *
 * - `auto` marks the flush, which forbids the stop-and-replay fallback. The
 *   operator did not ask for an interruption, so an automatic steer that fails
 *   leaves the message queued for the next boundary.
 * - The failure status follows from that. "Send now" reports `unsupported`,
 *   which licenses the machine to stop the turn and replay the message — the
 *   only way to honour "now" on a harness with no live channel. The flush
 *   reports `deferred`: nothing is wrong, it simply did not land this time.
 */
const beginSteer = (
  context: ConversationContext,
  self: { send: (event: ConversationEvent) => void },
  picked: QueuedMessage,
  auto: boolean
): void => {
  void rpc
    .agentSteer(context.session.id, context.chatId, picked.text, picked.images)
    .then((result) => self.send({ type: "STEER_RESULT", queued: picked, result, auto }))
    .catch(() =>
      self.send({
        type: "STEER_RESULT",
        queued: picked,
        result: { status: auto ? "deferred" : "unsupported" },
        auto
      })
    )
}

/**
 * A new turn clears the tab bar — but the reviewer is not part of a turn. Keep a
 * working one (sending a message must not cost you sight of a live agent that is
 * still running in the background); drop a finished one, which matches how a
 * sub-agent's tab clears when the next run starts.
 */
const keepReviewer = (reviewer: Subagent | null): Subagent | null =>
  reviewer?.status === "working" ? reviewer : null

/**
 * Rebuild the resident transcript from a freshly re-read on-disk tail.
 *
 * The trim is a TAIL REFETCH, not a positional head-slice, and the cursor
 * semantics force that choice: `Sessions.transcriptPage`'s cursor is an opaque
 * POSITIONAL offset into the on-disk message index (`v1:${start}`, see
 * `TranscriptStore.listPage`) and never an id — so a local `u_local_*` /
 * `a_local_*` id is not a usable cursor. A head-slice would have to DERIVE the
 * new cursor from how many messages it dropped, which is sound only if the
 * resident array is positionally 1:1 with disk, and it is not: `loadConversation`
 * and `applySharedPlan` append a synthetic `a_shared_plan_*` message that exists
 * on no disk row, and `applyHistory` filters and prepends. Re-reading the tail
 * sidesteps every alignment question — the messages AND the `hasMore`/`cursor`
 * that page "Load earlier" all come from the same disk read, so they cannot
 * disagree. Sound only because main persists the whole settled turn BEFORE it
 * forwards `Done`/`Failed` (agent-runner `emit`: `patchLast` then `out.offer`),
 * so a tail read taken at the idle turn boundary always includes the last turn.
 *
 * The shared plan is re-grafted exactly as on load: its canonical body lives in
 * `sharedPlan`, and when the plan's own message has been trimmed out of the tail
 * a synthetic card is re-appended so the inline plan bubble survives. The Plan
 * panel reads `sharedPlan`/`Plan.watch`, not this message, so it is unaffected
 * either way.
 */
export const trimmedTailState = (
  tail: ReadonlyArray<Message>,
  hasMore: boolean,
  cursor: string | null,
  sharedPlan: Plan | null
): {
  readonly messages: ReadonlyArray<Message>
  readonly hasMoreHistory: boolean
  readonly historyCursor: string | null
} => {
  const { messages, grafted } = projectLoadedPlan(tail, sharedPlan)
  const withPlan =
    sharedPlan === null || grafted
      ? messages
      : [
          ...messages,
          {
            ...applyStreamEvent(
              assistantMessage(`a_shared_plan_${stamp()}`, new Date().toISOString()),
              { _tag: "PlanProposed", plan: sharedPlan }
            ),
            streaming: false
          }
        ]
  return { messages: withPlan, hasMoreHistory: hasMore, historyCursor: cursor }
}

/**
 * The latest context reading, not a high-water mark. A harness that reports no
 * breakdown clears the previous one rather than leaving a stale composition
 * under a fresh total.
 */
const foldUsage = (
  e: Extract<StreamEvent, { readonly _tag: "Usage" }>
): Pick<ConversationContext, "tokens" | "contextBreakdown"> => ({
  tokens: e.tokens,
  contextBreakdown: e.breakdown ?? null
})

const reconciledSession = (context: ConversationContext, session: Session, clearModelPending: boolean): Partial<ConversationContext> => {
  const chat = session.chats.find((candidate) => candidate.id === context.chatId)
  if (chat === undefined) return { session }
  const persistedMode = chat.mode ?? session.mode ?? "accept-edits"
  return {
    session,
    runtimeId: chat.runtimeId ?? session.runtimeId ?? null,
    endpointId: chat.endpointId ?? session.endpointId ?? null,
    connectionId: chat.connectionId ?? session.connectionId ?? null,
    providerId: chat.providerId ?? session.providerId ?? null,
    modelId: chat.modelId ?? session.modelId ?? null,
    ...(clearModelPending ? { modelPending: false } : {}),
    // Plan is a transient overlay; session updates only replace its restore-on-approval mode.
    mode: isExecutionMode(context.mode) ? persistedMode : context.mode,
    executionMode: isExecutionMode(persistedMode) ? persistedMode : context.executionMode,
    reasoning: chat.reasoning,
    tokens: chat.contextTokens ?? context.tokens,
    persistedStatus: session.status
  }
}

const initialConversationChat = (input: { session: Session; chatId?: string }) => {
  const chats = input.session.chats ?? []
  return chats.find((candidate) => candidate.id === (input.chatId ?? input.session.activeChatId)) ?? chats[0] ?? {
    id: input.chatId ?? input.session.activeChatId ?? input.session.id,
    title: null,
    createdAt: input.session.updatedAt,
    updatedAt: input.session.updatedAt,
    mode: input.session.mode,
    contextTokens: input.session.contextTokens
  }
}
const initialConversationContext = (input: { session: Session; chatId?: string }): ConversationContext => {
  const chat = initialConversationChat(input)
  return {
    session: input.session, chatId: chat.id, messages: [], sessionEventCursor: { sequence: 0, revision: 0, eventIds: [] }, remotePublishProgress: null,
    mode: chat.mode ?? input.session.mode ?? "accept-edits", executionMode: chat.mode && isExecutionMode(chat.mode) ? chat.mode : "accept-edits",
    skills: [], files: [], runtimeId: chat.runtimeId ?? input.session.runtimeId ?? null, endpointId: chat.endpointId ?? input.session.endpointId ?? null,
    connectionId: chat.connectionId ?? input.session.connectionId ?? null, providerId: chat.providerId ?? input.session.providerId ?? null,
    modelId: chat.modelId ?? input.session.modelId ?? null, modelPending: false, diffStat: { added: 0, removed: 0, files: 0 }, patchAt: 0,
    pendingText: "", pendingAgentContext: "", pendingImages: [], pendingExternalInstruction: null, pendingExternalAcceptances: [], reasoning: chat.reasoning,
    queued: [], steeringId: null, queueParked: false, subagents: [], subagentFleetEvents: [], subagentControlOutcomes: [], foldsSinceCompaction: 0,
    sharedPlanChatId: null, sharedPlan: null, tokens: chat.contextTokens ?? input.session.contextTokens ?? 0, contextBreakdown: null,
    runStartedAt: null, lastOutcome: null, persistedStatus: input.session.status, loaded: false, hasMoreHistory: false, historyCursor: null,
    loadingHistory: false, reviewer: null, reviewPhase: "starting", reviewStartedAt: null
  }
}

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as { session: Session; chatId?: string }
  },
  actors: {
    loadConversation,
    historyPage,
    agentStream,
    refreshDiff,
    reviewStream,
    stopAgent
  },
  guards: {
    /**
     * Whether a SESSION_UPDATED carries anything new. XState's `assign`
     * allocates a fresh context object even when the update is an empty
     * partial, and a fresh context defeats the renderer's context-identity
     * comparator — so a no-op echo (the registry's attach-time double-send, a
     * sync returning identical state) must be dropped BEFORE the action runs,
     * not inside it. Sessions are small schema-decoded records, so JSON text
     * is a sound and cheap structural equality.
     */
    sessionChanged: ({ context, event }) =>
      event.type === "SESSION_UPDATED" &&
      context.session !== event.session &&
      JSON.stringify(context.session) !== JSON.stringify(event.session),
    /** Same no-op filter for cross-chat plan broadcasts. */
    sharedPlanChanged: ({ context, event }) =>
      event.type === "SHARED_PLAN_UPDATED" &&
      (context.sharedPlanChatId !== event.producingChatId ||
        JSON.stringify(context.sharedPlan) !== JSON.stringify(event.plan)),
    isSessionSettled: ({ event }) =>
      event.type === "STREAM_EVENT" && event.event._tag === "SessionSettled",
    isTerminal: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      (event.event._tag === "Done" || event.event._tag === "Failed"),
    isAcceptedStreamEnvelope: ({ context, event }) =>
      event.type === "SESSION_EVENT_ENVELOPE" &&
      event.envelope.sessionId === context.session.id &&
      event.envelope.event._tag === "Stream" &&
      admitSessionEvent(context.sessionEventCursor, event.envelope).status === "accepted",
    isAcceptedSessionEnvelope: ({ context, event }) =>
      event.type === "SESSION_EVENT_ENVELOPE" &&
      event.envelope.sessionId === context.session.id &&
      event.envelope.event._tag !== "Stream" &&
      admitSessionEvent(context.sessionEventCursor, event.envelope).status === "accepted",
    isAcceptedTerminalSessionEnvelope: ({ context, event }) =>
      event.type === "SESSION_EVENT_ENVELOPE" &&
      event.envelope.sessionId === context.session.id &&
      (event.envelope.event._tag === "Cancelled" ||
        event.envelope.event._tag === "Terminal") &&
      admitSessionEvent(context.sessionEventCursor, event.envelope).status === "accepted",
    hasQueued: ({ context }) => context.queued.length > 0,
    /**
     * Ready to start the next queued turn — nothing queued is still in flight.
     *
     * `hasQueued` alone is not enough once the queue can steer. The head stays in
     * the queue until its steer's reply says `accepted`, and that reply races the
     * turn's own end: when the diff refresh wins, dequeuing here replays a message
     * the agent HAS already been given, and the operator's correction runs twice.
     * So a pending steer parks the queue instead, and its reply restarts it (see
     * `awaitingInput`'s `STEER_RESULT`).
     */
    hasSettledQueue: ({ context }) =>
      context.queued.length > 0 &&
      context.steeringId === null &&
      !context.queueParked,
    /**
     * Whether anything is left to run once THIS steer result is applied — asked of
     * the event, because the guard runs before `settleLateSteer` removes an
     * accepted message from the queue.
     */
    queueSurvivesSteer: ({ context, event }) => {
      if (event.type !== "STEER_RESULT") return false
      // A parked queue stays parked: a late steer reply settles the latch but
      // must not auto-run messages the operator explicitly halted.
      if (context.queueParked) return false
      return context.queued.length > (event.result.status === "accepted" ? 1 : 0)
    },
    /**
     * Whether this stream event is a tool boundary we may flush the queue into.
     *
     * Deliberately narrow. A plan re-drive is excluded because its prompt is
     * machine-generated and a queued operator message would derail it.
     */
    canAutoFlush: ({ context, event }) => {
      if (event.type !== "STREAM_EVENT" || event.event._tag !== "ToolEnd") return false
      if (context.steeringId !== null || context.queued.length === 0) return false
      // A parked queue is inert until the operator acts on it — see `queueParked`.
      if (context.queueParked) return false
      return !requiresFreshTurn(context.queued[0]!)
    },
    canSteerQueued: ({ context, event }) => {
      if (event.type !== "SEND_NOW" || context.steeringId !== null) return false
      const queued = context.queued.find((item) => item.id === event.id)
      return queued !== undefined && !requiresFreshTurn(queued)
    },
    /**
     * "Send now" on a message that cannot travel the native steer channel —
     * hidden code-reference context (the steer RPC has no field for it) or
     * external feedback (its durable identity must be accepted through
     * Agent.run to keep relay replay idempotent).
     *
     * Merely promoting such a message did nothing visible: the row said
     * "queued", the button appeared dead, and the message waited for the whole
     * turn to end — indefinitely, when the turn was parked inside a
     * long-running tool (`gh pr checks --watch` held one for half an hour).
     * Honouring "now" takes the same stop-and-replay escalation a plain-text
     * send-now takes on a harness with no live channel. That path is SAFE for
     * external feedback: the dequeue runs through Agent.run, which is exactly
     * the durable identity-acceptance boundary — only steering would bypass
     * it, and this guard never steers. The machine never escalates on its own;
     * a click on the row's "Send now" is an operator request by definition.
     */
    sendNowNeedsFreshTurn: ({ context, event }) => {
      if (event.type !== "SEND_NOW") return false
      const queued = context.queued.find((item) => item.id === event.id)
      return queued !== undefined && requiresFreshTurn(queued)
    },
    /** A queued row exists for this SEND_NOW — the idle dequeue path's guard. */
    hasQueuedMessage: ({ context, event }) =>
      event.type === "SEND_NOW" &&
      context.queued.some((item) => item.id === event.id),
    canCoalesceExternalSend: ({ context, event }) =>
      event.type === "SEND" &&
      event.externalInstruction !== undefined &&
      (sameExternalInstruction(
        context.pendingExternalInstruction,
        event.externalInstruction
      ) ||
        context.queued.some((queued) =>
          sameExternalInstruction(queued.externalInstruction, event.externalInstruction!)
        )),
    isDuplicateExternalAcceptance: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      event.event._tag === "ExternalInstructionAccepted" &&
      event.event.duplicate,
    isExternalAcceptance: ({ event }) =>
      event.type === "STREAM_EVENT" &&
      event.event._tag === "ExternalInstructionAccepted",
    /** Older turns remain, and no page is already in flight. */
    canLoadOlder: ({ context }) =>
      context.hasMoreHistory &&
      context.historyCursor !== null &&
      !context.loadingHistory,
  },
  actions: {
    admitSessionEnvelope: assign(({ context, event }) => {
      if (event.type !== "SESSION_EVENT_ENVELOPE") return {}
      const admission = admitSessionEvent(context.sessionEventCursor, event.envelope)
      return admission.status === "accepted"
        ? { sessionEventCursor: admission.cursor }
        : {}
    }),
    raiseSessionStream: raise(({ event }) => {
      if (
        event.type !== "SESSION_EVENT_ENVELOPE" ||
        event.envelope.event._tag !== "Stream"
      ) {
        throw new Error("Only stream session envelopes can be folded into a conversation")
      }
      return { type: "STREAM_EVENT", event: event.envelope.event.event }
    }),
    beginRemoteTurn: assign(({ context, event }) => {
      if (event.type !== "SESSION_EVENT_ENVELOPE") return {}
      const last = context.messages.at(-1)
      if (last?.role === "assistant" && last.streaming) return {}
      return {
        runStartedAt: event.envelope.occurredAt * 1_000,
        lastOutcome: null,
        messages: [
          ...context.messages,
          assistantMessage(
            `a_remote_${event.envelope.eventId}`,
            new Date(event.envelope.occurredAt * 1_000).toISOString()
          )
        ]
      }
    }),
    applySessionEnvelope: assign(({ context, event }) => {
      if (
        event.type !== "SESSION_EVENT_ENVELOPE" ||
        event.envelope.event._tag === "Stream"
      ) return {}
      const admission = admitSessionEvent(context.sessionEventCursor, event.envelope)
      if (admission.status !== "accepted") return {}
      const remote = event.envelope.event
      if (remote._tag === "StatusChanged") {
        return {
          sessionEventCursor: admission.cursor,
          session: { ...context.session, status: remote.status },
          persistedStatus: remote.status
        }
      }
      if (remote._tag === "DiffChanged") {
        const diff = remoteDiffTotals(remote)
        return {
          sessionEventCursor: admission.cursor,
          session: { ...context.session, diff }
        }
      }
      if (remote._tag === "PublishProgress") {
        return {
          sessionEventCursor: admission.cursor,
          remotePublishProgress: { phase: remote.phase, message: remote.message }
        }
      }
      const terminal = remote._tag === "Cancelled"
        ? { _tag: "Failed" as const, message: remote.reason }
        : remote.outcome === "completed"
          ? { _tag: "Done" as const, costUsd: 0, tokens: context.tokens }
          : { _tag: "Failed" as const, message: remote.message ?? "Remote session failed." }
      const last = context.messages.at(-1)
      const messages = last?.role === "assistant"
        ? patchLast(context.messages, (message) => applyStreamEvent(message, terminal))
        : [
            ...context.messages,
            applyStreamEvent(
              assistantMessage(
                `a_remote_${event.envelope.eventId}`,
                new Date(event.envelope.occurredAt * 1_000).toISOString()
              ),
              terminal
            )
          ]
      return {
        sessionEventCursor: admission.cursor,
        messages,
        session: { ...context.session, status: "idle" },
        persistedStatus: "idle",
        runStartedAt: null,
        lastOutcome:
          remote._tag === "Terminal"
            ? remote.outcome === "completed" ? "done" as const : "failed" as const
            : null
      }
    }),
    appendTurns: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const text = event.text
      const agentContext = event.agentContext ?? ""
      const images = event.images ?? []
      const now = new Date().toISOString()
      const id = stamp()
      if (context.persistedStatus === "settled") {
        void rpc.sessionsSetStatus(context.session.id, "idle").then(publishSessionUpdate).catch(() => {})
      }
      return {
        ...(context.persistedStatus === "settled"
          ? { session: { ...context.session, status: "idle" as const }, persistedStatus: "idle" as const }
          : {}),
        pendingText: text,
        pendingAgentContext: agentContext,
        pendingImages: images,
        pendingExternalInstruction: event.externalInstruction ?? null,
        pendingExternalAcceptances:
          event.externalInstruction !== undefined && event.onExternalAccepted !== undefined
            ? [event.onExternalAccepted]
            : [],
        // See `dequeueTurn`: a new run must never inherit the previous turn's
        // in-flight steer guard.
        steeringId: null,
        // A fresh turn starts with no sub-agents (any from a prior turn are gone).
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        // Context occupancy belongs to the resumed harness conversation, not to
        // one run. Keep the last reading visible until Usage replaces it.
        runStartedAt: Date.now(),
        lastOutcome: null,
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, text, now, images),
          assistantMessage(`a_local_${id}`, now, context.providerId ?? undefined)
        ]
      }
    }),
    // Hold a message sent mid-run; it's replayed as a fresh turn once the agent
    // frees up (see `dequeueTurn`). A send with neither text nor images is ignored.
    enqueue: assign(({ context, event }) => {
      if (event.type !== "SEND") return {}
      const text = event.text.trim()
      const agentContext = event.agentContext ?? ""
      const images = event.images ?? []
      if (text.length === 0 && images.length === 0 && agentContext === "") return {}
      return {
        // A fresh send re-engages a queue parked by Stop: the operator is
        // active again, so held messages resume draining in order.
        queueParked: false,
        queued: [
          ...context.queued,
          {
            id: `q_${stamp()}_${context.queued.length}`,
            text,
            agentContext,
            images,
            ...(event.externalInstruction === undefined
              ? {}
              : { externalInstruction: event.externalInstruction }),
            externalAcceptances:
              event.externalInstruction !== undefined && event.onExternalAccepted !== undefined
                ? [event.onExternalAccepted]
                : []
          }
        ]
      }
    }),
    coalesceExternalSend: assign(({ context, event }) => {
      if (
        event.type !== "SEND" ||
        event.externalInstruction === undefined ||
        event.onExternalAccepted === undefined
      ) {
        return {}
      }
      if (sameExternalInstruction(context.pendingExternalInstruction, event.externalInstruction)) {
        return {
          pendingExternalAcceptances: [
            ...context.pendingExternalAcceptances,
            event.onExternalAccepted
          ]
        }
      }
      return {
        queued: context.queued.map((queued) =>
          sameExternalInstruction(queued.externalInstruction, event.externalInstruction!)
            ? {
                ...queued,
                externalAcceptances: [
                  ...queued.externalAcceptances,
                  event.onExternalAccepted!
                ]
              }
            : queued
        )
      }
    }),
    acceptExternalInstruction: assign(({ context, event }) => {
      if (
        event.type !== "STREAM_EVENT" ||
        event.event._tag !== "ExternalInstructionAccepted" ||
        !sameExternalInstruction(context.pendingExternalInstruction, event.event.identity)
      ) {
        return {}
      }
      for (const accepted of context.pendingExternalAcceptances) accepted()
      return { pendingExternalAcceptances: [] }
    }),
    discardDuplicateExternalTurn: assign(({ context }) => {
      // A duplicate acceptance means the instruction is already durably in the
      // transcript. Any acceptance callback still pending here must fire, not
      // vanish: a dropped callback strands the relay dispatch promise, which
      // withholds the cursor acknowledgement and freezes the session's whole
      // event stream. (`acceptExternalInstruction` usually fired them already,
      // in which case this array is empty and the loop is a no-op.)
      for (const accepted of context.pendingExternalAcceptances) accepted()
      return {
        messages: context.messages.slice(0, -2),
        pendingText: "",
        pendingAgentContext: "",
        pendingImages: [],
        pendingExternalInstruction: null,
        pendingExternalAcceptances: [],
        runStartedAt: null,
        lastOutcome: null
      }
    }),
    // Drop a still-pending queued message before it's sent.
    removeQueued: assign(({ context, event }) => {
      if (event.type !== "UNQUEUE") return {}
      const removed = context.queued.find((queued) => queued.id === event.id)
      // The operator deliberately discarded this message. Resolve any external
      // acceptance waiting on it — the relay treats that as handled and moves
      // on, instead of holding the cursor for a dispatch that can never come.
      for (const accepted of removed?.externalAcceptances ?? []) accepted()
      return { queued: context.queued.filter((queued) => queued.id !== event.id) }
    }),
    // Rewrite a queued message in place. Nothing has been sent yet, so this is a
    // pure context edit — the position is deliberately preserved, and so is the
    // id: an edit must not turn one queued message into a different one, or the
    // steer already in flight for it would stop recognising its own reply.
    editQueued: assign(({ context, event }) => {
      if (event.type !== "EDIT_QUEUED") return {}
      const picked = context.queued.find((queued) => queued.id === event.id)
      if (picked === undefined) return {}
      const text = event.text.trim()
      // An emptied message with no images would be sent as a blank turn.
      if (text.length === 0 && picked.images.length === 0 && picked.agentContext === "") {
        return { queued: context.queued.filter((queued) => queued.id !== event.id) }
      }
      return {
        queued: context.queued.map((item) => (item.id === event.id ? { ...item, text } : item))
      }
    }),
    // "Send now": jump a queued message to the head so it runs as the very next
    // turn. Paired with `callStop` in `running`, this interrupts the current turn
    // to steer the agent immediately; the remaining queue keeps its order behind it.
    promoteQueued: assign(({ context, event }) => {
      if (event.type !== "SEND_NOW") return {}
      const picked = context.queued.find((queued) => queued.id === event.id)
      if (picked === undefined) return {}
      const rest = context.queued.filter((queued) => queued.id !== event.id)
      // "Send now" is an explicit operator action, so it always unparks.
      return { queued: [picked, ...rest], queueParked: false }
    }),
    promoteAndSteer: assign(({ context, event, self }) => {
      if (event.type !== "SEND_NOW" || context.steeringId !== null) return {}
      const picked = context.queued.find((queued) => queued.id === event.id)
      if (picked === undefined) return {}
      const rest = context.queued.filter((queued) => queued.id !== event.id)
      beginSteer(context, self, picked, false)
      return { queued: [picked, ...rest], steeringId: picked.id, queueParked: false }
    }),
    /**
     * Hand the HEAD of the queue to the live turn at a tool boundary — the
     * Claude-Code feel the queue was missing.
     *
     * The queue used to sit untouched until the whole turn (and its diff refresh)
     * had settled, so a one-line correction typed 10 seconds in was answered
     * minutes later, against work it was meant to redirect. Flushing on `ToolEnd`
     * puts it in front of the agent at the first natural break instead, and the
     * harness decides when to act on it.
     *
     * Guarded by `canAutoFlush`: only where steering is NATIVE, only on ordinary
     * turns, and only one in flight at a time — an auto-flush that fell back to
     * stop-and-replay would interrupt the turn at every tool call.
     */
    autoFlushQueue: assign(({ context, self }) => {
      const picked = context.queued[0]
      if (picked === undefined) return {}
      beginSteer(context, self, picked, true)
      return { steeringId: picked.id }
    }),
    acceptSteer: assign(({ context, event }) => {
      if (
        event.type !== "STEER_RESULT" ||
        event.result.status !== "accepted"
      ) {
        return {}
      }
      const last = context.messages.at(-1)
      const prior =
        last?.role === "assistant"
          ? [...context.messages.slice(0, -1), settleStreaming(last)]
          : context.messages
      return {
        // By id, not object identity: an edit landing while this steer was in
        // flight replaces the object, and the message would then survive the
        // filter and run a SECOND time — the agent already has it.
        queued: context.queued.filter((queued) => queued.id !== event.queued.id),
        messages: [...prior, event.result.user, event.result.assistant],
        steeringId: null
      }
    }),
    finishSteer: assign(() => ({ steeringId: null })),
    /**
     * A steer's reply that arrived AFTER the turn it belonged to had ended.
     *
     * The reply and the turn's terminal event travel different paths (an RPC
     * response vs the event stream), so the `Done` can land first and leave this
     * event to be handled in `refreshingDiff`/`stopping`/`awaitingInput` instead
     * of `running`. Unhandled it does real damage, not nothing: `steeringId`
     * latches forever, which silently disables BOTH the automatic flush and
     * "Send now" for the rest of the chat's life; and an `accepted` message never
     * leaves the queue, so the next dequeue replays a message the agent already
     * answered — the operator's correction runs twice.
     *
     * Messages are deliberately NOT appended here. The agent took this text
     * inside the turn that just ended, so its answer is already in the transcript
     * (folded into that turn's assistant message), and main has appended the pair
     * to the stored transcript. Adding them again would duplicate the prompt and
     * leave an empty assistant bubble streaming forever, since no further events
     * are coming.
     */
    settleLateSteer: assign(({ context, event }) => {
      if (event.type !== "STEER_RESULT") return { steeringId: null }
      return {
        steeringId: null,
        queued:
          event.result.status === "accepted"
            ? context.queued.filter((queued) => queued.id !== event.queued.id)
            : context.queued
      }
    }),
    /**
     * Stop with messages still queued: keep them, but hold them inert. See
     * `queueParked` — clearing here silently destroyed exactly the messages
     * that cannot steer (snippet context, external feedback).
     */
    parkQueue: assign(({ context }) => ({
      queueParked: context.queued.length > 0
    })),
    // Pop the head of the queue into a fresh turn — the same shape `appendTurns`
    // produces for a live SEND, so `running` streams it exactly as a normal turn.
    dequeueTurn: assign(({ context }) => {
      const [next, ...rest] = context.queued
      if (next === undefined) return {}
      const now = new Date().toISOString()
      const id = stamp()
      if (context.persistedStatus === "settled") {
        void rpc.sessionsSetStatus(context.session.id, "idle").then(publishSessionUpdate).catch(() => {})
      }
      return {
        ...(context.persistedStatus === "settled"
          ? { session: { ...context.session, status: "idle" as const }, persistedStatus: "idle" as const }
          : {}),
        queued: rest,
        pendingText: next.text,
        pendingAgentContext: next.agentContext,
        pendingImages: next.images,
        pendingExternalInstruction: next.externalInstruction ?? null,
        pendingExternalAcceptances: next.externalAcceptances,
        // A new run starts UNLATCHED. `steeringId` guards one in-flight steer
        // against the turn it was aimed at; carrying it into the next turn would
        // disable the flush and "Send now" for a reply that can no longer come.
        steeringId: null,
        queueParked: false,
        subagents: [],
        reviewer: keepReviewer(context.reviewer),
        runStartedAt: Date.now(),
        lastOutcome: null,
        messages: [
          ...context.messages,
          userMessage(`u_local_${id}`, next.text, now, next.images),
          assistantMessage(`a_local_${id}`, now, context.providerId ?? undefined)
        ]
      }
    }),
    recoverSubagentFleet: assign(({ context, event }) =>
      event.type === "RECOVER_SUBAGENT_FLEET"
        ? { subagentFleetEvents: boundedFleetEvents([
            ...context.subagentFleetEvents,
            ...event.events
          ]) }
        : {}
    ),
    applySettled: assign(({ context }) => {
      const session = { ...context.session, status: "settled" as const }
      publishSessionUpdate(session)
      return { session, persistedStatus: "settled" as const }
    }),
    foldEvent: assign(({ context, event, self }) => {
      if (event.type !== "STREAM_EVENT") return {}
      const e = event.event
      // The harness has revealed that a task we already opened a tab for is
      // BACKGROUNDED. It lives in the session dock from here on, so retract the
      // tab rather than showing the same work twice — see `retractSubagent`.
      // `toolUseId` is the spawning tool_use id, i.e. exactly the tab's own id;
      // tasks with no tool_use (ambient/workflow) never opened one.
      if (e._tag === "BackgroundTaskStarted") {
        return e.toolUseId === null ? {} : { subagents: retractSubagent(context.subagents, e.toolUseId) }
      }
      if (e._tag === "SubagentFleetChanged") {
        return {
          subagentFleetEvents: boundedFleetEvents([...context.subagentFleetEvents, e.event])
        }
      }
      if (e._tag === "SubagentFleetControlAcknowledged") {
        return {
          subagentControlOutcomes: [
            ...context.subagentControlOutcomes,
            e.outcome
          ].slice(-64)
        }
      }
      // Sub-agent-scoped events drive the watch-only tabs, not the main turn.
      if (isSubagentEvent(e)) {
        return foldSubagentStream(context, e)
      }
      // This is the latest context size, not a high-water mark. Compaction can
      // legitimately make it smaller during a run.
      if (e._tag === "Usage") {
        return foldUsage(e)
      }
      // A compaction reseeds the harness, so the working set restarts from the
      // primer. Reset the reading immediately rather than waiting for the next
      // `Usage`: leaving the old number up means the meter sits pinned at full
      // through the very turn that fixed it, which reads as the feature not
      // working. It also folds into the transcript, so the marker renders.
      if (e._tag === "ContextCompacted") {
        return {
          tokens: 0,
          contextBreakdown: null,
          messages: patchLast(context.messages, (last) => applyStreamEvent(last, e))
        }
      }
      if (e._tag === "PlannotatorStateChanged") {
        if (e.state.phase === "executing" && context.mode === "plan") {
          self.send({ type: "SET_MODE", mode: "auto" })
        }
        return { plannotator: e.state }
      }
      if (e._tag === "PlanProposed") {
        return {
          messages: patchLast(context.messages, (last) => applyStreamEvent(last, e)),
          sharedPlanChatId: context.chatId,
          sharedPlan: e.plan
        }
      }
      // A `PlanUpdated` addresses a plan by id, and that plan part lives in the
      // message of the turn it was PROPOSED in — which, once execution runs on
      // into later turns, is not the last message. Folding it with `patchLast`
      // targets a message holding no plan, so every cross-turn progress tick is
      // silently dropped. Address the plan's own message instead.
      if (e._tag === "PlanUpdated") {
        return {
          messages: context.messages.map((m) =>
            m.parts.some((p) => p._tag === "Plan" && p.plan.id === e.plan.id)
              ? applyStreamEvent(m, e)
              : m
          ),
          sharedPlan: e.plan
        }
      }
      return foldMainStreamEvent(context, e)
}),
    clearSubagents: assign(() => ({ subagents: [] as ReadonlyArray<Subagent> })),
    settleStoppedFleet: assign(({ context }) => ({
      subagentFleetEvents: boundedFleetEvents(
        settleStoppedFleet(context.subagentFleetEvents, Date.now())
      )
    })),
    markHistoryLoading: assign(() => ({ loadingHistory: true })),
    /**
     * Prepend an older page. No overlap to dedupe — the store returns messages
     * strictly before the cursor. `settleLoaded` because an older turn could have
     * been left mid-stream by a past crash, exactly as on the initial load.
     */
    applyHistory: assign(({ context, event }) => {
      if (event.type !== "HISTORY_LOADED") return {}
      const projected = projectLoadedPlan(event.messages, context.sharedPlan)
      const existing =
        projected.grafted && context.sharedPlan !== null
          ? context.messages.filter(
              (message) =>
                !(
                  message.id.startsWith("a_shared_plan_") &&
                  message.parts.some(
                    (part) =>
                      part._tag === "Plan" &&
                      part.plan.id === context.sharedPlan!.id
                  )
                )
            )
          : context.messages
      return {
        messages: [...compactMessages(projected.messages), ...existing],
        hasMoreHistory: event.hasMore,
        historyCursor: event.cursor,
        loadingHistory: false
      }
    }),
    /**
     * Re-read the on-disk tail when the live array has outgrown its window, and
     * swap it in (`applyTrimmedTail`). Fire-and-forget like `loadCatalog`: the
     * reply is a plain event, silently dropped if the machine has since left idle
     * — the next idle boundary re-fires. Skipped while a "Load earlier" page is
     * in flight, whose positional cursor the swap would strand.
     */
    requestHistoryTrim: ({ context, self }) => {
      if (context.loadingHistory || !shouldTrimLiveHistory(context.messages.length)) return
      void rpc
        .sessionsTranscriptPage(
          context.session.id,
          context.chatId,
          undefined,
          HISTORY_PAGE_SIZE
        )
        .then((page) =>
          self.send({
            type: "HISTORY_TRIMMED",
            messages: page.messages,
            hasMore: page.hasMore,
            cursor: page.cursor ?? null
          })
        )
        .catch(() => {})
    },
    applyTrimmedTail: assign(({ context, event }) => {
      if (event.type !== "HISTORY_TRIMMED") return {}
      // Only ever swaps the array SMALLER, and only at a settled turn boundary
      // (this action is reachable in `awaitingInput` and `refreshingDiff`, both
      // entered after the terminal event folded — so `messages` holds no
      // streaming turn, and main has persisted the whole settled turn before
      // forwarding it). Re-check the cap so a reply that raced the array back
      // under the window is a no-op, and the history load so its cursor is
      // never stranded.
      if (context.loadingHistory || !shouldTrimLiveHistory(context.messages.length)) {
        return {}
      }
      const state = trimmedTailState(event.messages, event.hasMore, event.cursor, context.sharedPlan)
      return { ...state, messages: compactMessages(state.messages) }
    }),
    /**
     * Ask the harness to kill ONE sub-agent. Fire-and-forget, and with NO
     * optimistic status change: the pill stays `working` until the harness's own
     * `task_notification` settles it to `stopped`, which is the only moment the
     * agent has actually stopped. Flipping it early would show a settled dot over
     * an agent still writing to the file system.
     */
    requestStopSubagent: ({ context, event }) => {
      if (event.type !== "STOP_SUBAGENT") return
      void rpc.agentStopSubagent(context.session.id, context.chatId, event.agentId).catch(() => {})
    },
    /**
     * Drop a settled sub-agent's tab, and with it any tabs it spawned — a child
     * has no rail to live on once its parent's crumb is gone (`retractSubagent`
     * takes the descendants for exactly this reason).
     *
     * Guarded on `working` rather than trusted from the UI: the rail routes a ×
     * on a live agent to `STOP_SUBAGENT`, but a tab that retracted here while
     * still running would drop the only surface its `SubagentEnded` could land
     * on, and the agent would go on working with nothing on screen.
     */
    closeSubagent: assign(({ context, event }) => {
      if (event.type !== "CLOSE_SUBAGENT") return {}
      const agent = context.subagents.find((s) => s.id === event.agentId)
      if (!agent || agent.status === "working") return {}
      return { subagents: retractSubagent(context.subagents, event.agentId) }
    }),
    // Realtime Changes rail + asset links: when a tool that touched files lands
    // mid-run, re-read the worktree right away (fire-and-forget) so both surfaces
    // reflect edits as they happen, not only after the conversation reloads.
    //
    // Prefer `ToolEnd.diff`, but do not require it: Codex has emitted successful
    // `Edit` events with `diff: null`. Resolve those back to their ToolStart name
    // so a newly created path mentioned in the response becomes openable.
    liveRefreshDiff: ({ context, event, self }) => {
      if (event.type !== "STREAM_EVENT") return
      const e = event.event
      if (e._tag === "SessionIssueLinksChanged") {
        void rpc.sessionsGet(context.session.id).then(publishSessionUpdate).catch(() => {})
        return
      }
      if (e._tag !== "ToolEnd" || e.status !== "success") return
      const toolName = toolNameFor(context, e.id, e.agentId)
      const hasCanonicalChanges = (e.fileChanges?.changes.length ?? 0) > 0
      if (
        !hasCanonicalChanges &&
        e.diff === null &&
        (toolName === null || !isFileMutationTool(toolName))
      ) return
      void rpc
        .sessionsDiffStat(context.session.id)
        .then((diffStat) => self.send({ type: "DIFF_STAT_UPDATED", diffStat }))
        .catch(() => {})
      // The same signal re-reads the worktree's file list. Without this, a file
      // the agent creates mid-turn is missing from `files` until the whole
      // conversation reloads — which means the `@` menu can't reference it and,
      // worse, the Preview dock's clickability gate rejects the very path the
      // agent just announced. The list is small (one `git ls-files` pair) and
      // this only fires on a tool that actually touched files.
      const worktreePath = context.session.worktreePath
      if (worktreePath) {
        void rpc
          .workspaceFiles(
            worktreePath,
            context.session.environmentId,
            context.session.id
          )
          .then((files) => self.send({ type: "FILES_UPDATED", files }))
          .catch(() => {})
      }
    },
    applyLivePatch: assign(({ event }) =>
      event.type === "DIFF_STAT_UPDATED"
        ? { diffStat: event.diffStat, patchAt: Date.now() }
        : {}
    ),
    applyLiveFiles: assign(({ event }) =>
      event.type === "FILES_UPDATED" ? { files: event.files } : {}
    ),
    optimisticGate: assign(({ context, event }) => {
      if (event.type !== "DECIDE_GATE") return {}
      void rpc.agentDecideGate(
        context.session.id,
        context.chatId,
        event.gateId,
        event.decision
      )
      const status = gateStatusFor(event.decision)
      return { messages: context.messages.map((m) => setGateStatus(m, event.gateId, status)) }
    }),
    optimisticAnswer: assign(({ context, event }) => {
      if (event.type !== "ANSWER_QUESTION") return {}
      void rpc.agentAnswerQuestion(
        context.session.id,
        context.chatId,
        event.requestId,
        event.answers
      )
      return {
        messages: context.messages.map((m) => setQuestionAnswers(m, event.requestId, event.answers))
      }
    }),
    persistMode: assign(({ context, event }) => {
      if (event.type !== "SET_MODE") return {}
      void rpc.agentSetMode(context.session.id, context.chatId, event.mode)
      return isExecutionMode(event.mode)
        ? { mode: event.mode, executionMode: event.mode }
        : { mode: event.mode }
    }),
    persistReasoning: assign(({ context, event }) => {
      if (event.type !== "SET_REASONING") return {}
      void rpc.agentSetReasoning(context.session.id, context.chatId, event.reasoning)
      return {
        reasoning: event.reasoning,
        session: {
          ...context.session,
          chats: context.session.chats.map((chat) =>
            chat.id === context.chatId
              ? { ...chat, reasoning: event.reasoning }
              : chat
          )
        }
      }
    }),
    reconcileSession: assign(({ context, event }) => {
      if (
        event.type !== "SESSION_UPDATED" &&
        event.type !== "MODEL_PERSISTED" &&
        event.type !== "MODEL_PERSIST_FAILED"
      ) return {}
      return reconciledSession(context, event.session, event.type !== "SESSION_UPDATED")
    }),
    applySharedPlan: assign(({ context, event }) => {
      if (event.type !== "SHARED_PLAN_UPDATED") return {}
      const hasPlan = context.messages.some((message) =>
        message.parts.some(
          (part) => part._tag === "Plan" && part.plan.id === event.plan.id
        )
      )
      // Replace ONLY the messages that hold this plan. Rebuilding every
      // message gave the whole transcript fresh identities per broadcast,
      // which un-memoed every rendered turn — on a plan-heavy session that
      // was a full-transcript re-render for each progress update.
      const messages = hasPlan
        ? context.messages.map((message) =>
            message.parts.some(
              (part) => part._tag === "Plan" && part.plan.id === event.plan.id
            )
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part._tag === "Plan" && part.plan.id === event.plan.id
                      ? { _tag: "Plan" as const, plan: event.plan }
                      : part
                  )
                }
              : message
          )
        : [
            ...context.messages,
            {
              ...applyStreamEvent(
                assistantMessage(`a_shared_plan_${stamp()}`, new Date().toISOString()),
                { _tag: "PlanProposed", plan: event.plan }
              ),
              streaming: false
            }
          ]
      return {
        messages,
        sharedPlanChatId: event.producingChatId,
        sharedPlan: event.plan
      }
    }),
    persistProviderModel: assign(({ context, event, self }) => {
      if (event.type !== "SET_MODEL") return {}
      const session = withProviderModel(
        context.session,
        context.chatId,
        event.runtimeId,
        event.endpointId,
        event.connectionId,
        event.providerId,
        event.modelId
      )
      persistModelSelection(
        `${context.session.id}:${context.chatId}`,
        () => rpc.agentEndpointSetModel(
          context.session.id,
          context.chatId,
          event.runtimeId,
          event.endpointId,
          event.providerId,
          event.modelId
        ),
        (persisted) => {
          publishSessionUpdate(persisted)
          self.send({ type: "MODEL_PERSISTED", session: persisted })
        },
        () => self.send({ type: "MODEL_PERSIST_FAILED", session: context.session })
      )
      return {
        runtimeId: event.runtimeId,
        endpointId: event.endpointId,
        connectionId: session.chats.find((chat) => chat.id === context.chatId)?.connectionId ?? null,
        providerId: event.providerId,
        modelId: event.modelId,
        modelPending: true,
        reasoning: session.chats.find((chat) => chat.id === context.chatId)?.reasoning,
        session
      }
    }),
    applySkills: assign(({ event }) => (event.type === "SKILLS_LOADED" ? { skills: event.skills } : {})),
    /**
     * The `/` menu's contents, fetched out of band for the same reason as the
     * catalogue above: `Skills.list` asks the HARNESS what commands it has,
     * which means spawning it — seconds, in the worst case. Awaiting it inside
     * `loadConversation` held the machine in `loading`, where SEND isn't
     * handled, so a prompt typed on open was silently dropped and the composer
     * did nothing at all.
     */
    loadSkills: ({ context, self }) => {
      void rpc
        .skillsList(context.session.id)
        .then((skills) => self.send({ type: "SKILLS_LOADED", skills }))
        .catch(() => {})
    },
    /**
     * Fetch the worktree file list + diff out of band, like `loadSkills` — a
     * repo walk and a git diff feed the @-mention menu and the Changes rail,
     * neither of which the transcript's first paint needs, and both of which
     * used to sit in `loadConversation`'s join and gate it.
     */
    loadWorkspaceMeta: ({ context, self }) => {
      const { session } = context
      void Promise.all([
        session.worktreePath
          ? rpc.workspaceFiles(
              session.worktreePath,
              session.environmentId,
              session.id
            )
          : Promise.resolve([] as ReadonlyArray<string>),
        rpc.sessionsDiffStat(session.id)
      ])
        .then(([files, diffStat]) =>
          self.send({ type: "WORKSPACE_META_LOADED", files, diffStat })
        )
        .catch(() => {})
    },
    applyWorkspaceMeta: assign(({ context, event }) => {
      if (event.type !== "WORKSPACE_META_LOADED") return {}
      // A turn that completed before this initial read landed has already
      // refreshed the diff with something newer — don't clobber it.
      return {
        files: event.files,
        ...(context.patchAt > 0
          ? {}
          : { diffStat: event.diffStat, patchAt: Date.now() })
      }
    }),
    /** Fold one reviewer event into its tab + the PR button's phase/timer. */
    applyReview: assign(({ context, event }) => {
      if (event.type !== "REVIEW_EVENT") return {}
      const e = event.event
      const phase = nextReviewPhase(context.reviewPhase, e)
      const settled = phase === "done" || phase === "error"
      return {
        reviewer: applyReviewEvent(context.reviewer, e),
        reviewPhase: phase,
        // Timed from `Started` (the run actually beginning), not from the click:
        // a watcher that attaches mid-run replays from the buffer, and anchoring
        // on attach would restart its clock at zero and under-report the age.
        // Cleared once settled so the button drops back to "Review again".
        reviewStartedAt: settled
          ? null
          : e._tag === "Started"
            ? Date.now()
            : (context.reviewStartedAt ?? Date.now())
      }
    }),
    /**
     * Record the SETTLED lifecycle status, so a session the operator hasn't opened
     * this run still reports whether it's idle or blocked on them (the sidebar
     * falls back to this when there's no live activity).
     *
     * Only ever a settled status — never "thinking"/"running". A run lives in the
     * main process and dies with the app, so persisting a busy status would leave
     * the session reading "thinking" forever after a restart, for a run that no
     * longer exists. Entering `awaitingInput` from `loading` also repairs any
     * status already stale from an earlier crash.
     */
    persistSettledStatus: assign(({ context }) => {
      // A failed transcript load also lands in `awaitingInput`, but with an empty
      // `messages` — which derives "idle" and would ERASE a truthful persisted
      // "needs-input" for a session genuinely blocked on the operator. Only a
      // transcript we actually read can be trusted to repair the status.
      if (!context.loaded) return {}
      // At the "idle" phase `activityOf` only ever reports a blocked-on-the-
      // operator activity (or nothing) — so the settled status falls straight out
      // of it, and a busy status is unrepresentable rather than merely avoided.
      const activity = activityOf(context.messages, "idle")
      const status: SettledSessionStatus = activity
        ? "needs-input"
        : context.persistedStatus === "settled"
          ? "settled"
          : "idle"
      if (status === context.persistedStatus) return {}
      // The machine writes this on its own, far from App.tsx — announce the
      // returned record so `appMachine`'s session list (the sidebar's fallback)
      // doesn't keep serving the pre-write status until the next restart.
      void rpc
        .sessionsSetStatus(context.session.id, status)
        .then(publishSessionUpdate)
        .catch(() => {
          /* best-effort: a failed status write must never break the turn */
        })
      return { persistedStatus: status }
    }),
    /**
     * Close out the turn the operator just halted.
     *
     * We can't wait for the runner's own terminal event: STOP leaves `running`
     * immediately, and `STREAM_EVENT` is only handled there — so that event
     * arrives to a machine that has stopped listening. Without this the turn
     * would spin forever (until a reload, where `settleLoaded` cleans it up).
     * Folding the SAME note the runner persists keeps the live view and a
     * reloaded transcript in agreement.
     */
    settleStoppedRun: assign(({ context }) => ({
      messages: patchLast(context.messages, (last) =>
        applyStreamEvent(last, { _tag: "Failed", message: STOPPED_NOTE })
      ),
      runStartedAt: null,
      pendingExternalInstruction: null,
      pendingExternalAcceptances: [],
      // The OPERATOR stopped this run. Recording it as `failed` would notify
      // them that their own deliberate action went wrong.
      lastOutcome: null
    }))
  }
}).createMachine({
  id: "conversation",
  initial: "loading",
  // Kick the (slow, out-of-band) model catalogue + `/` menu fetches off once, at
  // start. Both probe a CLI, so neither may gate the transcript — see below.
  entry: ["loadSkills", "loadWorkspaceMeta"],
  // Watch the reviewer for the machine's whole life — a review is not part of a
  // turn, so it can start, run and finish in any state.
  invoke: {
    src: "reviewStream",
    input: ({ context }) => ({ sessionId: context.session.id, chatId: context.chatId })
  },
  // All three can land in any state — they race nothing. SKILLS_LOADED belongs
  // here for the same reason CATALOG_LOADED does: now that the `/` menu is
  // fetched out of band, its reply can arrive while the transcript is still
  // loading, and a per-state handler would drop it on the floor.
  on: {
    SESSION_EVENT_ENVELOPE: {
      guard: "isAcceptedSessionEnvelope",
      actions: "applySessionEnvelope"
    },
    SKILLS_LOADED: { actions: "applySkills" },
    // The worktree file list + diff arrive out of band so the transcript's
    // first paint never waits on a repo walk or a git diff (see
    // `loadWorkspaceMeta`).
    WORKSPACE_META_LOADED: { actions: "applyWorkspaceMeta" },
    REVIEW_EVENT: { actions: "applyReview" },
    RECOVER_SUBAGENT_FLEET: { actions: "recoverSubagentFleet" },
    SET_REASONING: { actions: "persistReasoning" },
    SET_MODEL: { actions: "persistProviderModel" },
    MODEL_PERSISTED: { actions: "reconcileSession" },
    MODEL_PERSIST_FAILED: { actions: "reconcileSession" },
    SESSION_UPDATED: { guard: "sessionChanged", actions: "reconcileSession" },
    SHARED_PLAN_UPDATED: { guard: "sharedPlanChanged", actions: "applySharedPlan" },
    // Root-level for the same reason: a sub-agent's tab outlives the turn that
    // spawned it, so closing one has to work in `idle` — and a stop request
    // races nothing, since the harness answers it on the ordinary stream.
    STOP_SUBAGENT: { actions: "requestStopSubagent" },
    CLOSE_SUBAGENT: { actions: "closeSubagent" },
    // Paging older history races nothing (it only prepends to `messages`), so it
    // lives at the root and works in every state — including `running`, where the
    // operator may scroll back while the agent works.
    LOAD_OLDER: {
      guard: "canLoadOlder",
      actions: [
        "markHistoryLoading",
        spawnChild("historyPage", {
          id: "history-page",
          input: ({ context }) => ({
            sessionId: context.session.id,
            chatId: context.chatId,
            before: context.historyCursor!
          })
        })
      ]
    },
    HISTORY_LOADED: {
      actions: ["applyHistory", stopChild("history-page")]
    }
  },
  context: ({ input }) => initialConversationContext(input),
  states: {
    loading: {
      /**
       * The composer and its chips are on screen and interactive while this
       * runs, and `loadConversation` is not instant — it asks the harness for
       * its command list, which means spawning it. Without these, a model or
       * mode picked in that window is silently swallowed: the menu closes, the
       * chip snaps back, nothing happens.
       *
       * Safe here because `onDone` below assigns only transcript state
       * (messages/skills/files/patch) and never provider identity or `mode` — so a
       * choice made mid-load survives the transition rather than being clobbered.
       */
      on: {
        SET_MODE: { actions: "persistMode" },
        // The composer is enabled from the first paint, so a prompt can be sent
        // before the transcript lands — and a dropped one is invisible: the box
        // clears and the operator believes they sent it. Hold it and run it the
        // moment the load settles, exactly as a send during a run is held.
        SEND: [
          { guard: "canCoalesceExternalSend", actions: "coalesceExternalSend" },
          { actions: "enqueue" }
        ],
        // Whatever is held here is ON SCREEN as a queued row (a hand-off lands one
        // in a chat that is still loading), so its row actions have to work — an
        // edit or a remove dropped in this window would leave the row claiming the
        // operator's change had been made.
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" }
      },
      invoke: {
        src: "loadConversation",
        input: ({ context }) => ({
          session: context.session,
          chatId: context.chatId
        }),
        // A prompt sent while loading starts its turn as soon as the transcript
        // settles; otherwise we go idle. The transcript is applied either way.
        onDone: [
          {
            // Not bare `hasQueued`: when main still has a live turn for this
            // chat (renderer reload mid-run), starting the queued message now
            // would only collect the single-flight refusal. Hold it; the live
            // turn's envelopes re-attach the view and the queue drains at the
            // turn boundary — or the operator releases it with "Send now".
            guard: ({ context, event }) =>
              context.queued.length > 0 && !event.output.busy,
            target: "running",
            actions: [
              assign(({ event }) => ({
                // Compacted on the way in: a giant on-disk turn re-decoded
                // whole would restore the exact heap the live compaction
                // bounds. Same on every other disk→live path.
                messages: compactMessages(event.output.transcript),
                sharedPlanChatId: event.output.sharedPlanChatId,
                sharedPlan: event.output.sharedPlan,
                hasMoreHistory: event.output.hasMore,
                historyCursor: event.output.cursor,
                loaded: true
              })),
              "dequeueTurn"
            ]
          },
          {
            target: "awaitingInput",
            actions: assign(({ event }) => ({
              messages: compactMessages(event.output.transcript),
              sharedPlanChatId: event.output.sharedPlanChatId,
              sharedPlan: event.output.sharedPlan,
              hasMoreHistory: event.output.hasMore,
              historyCursor: event.output.cursor,
              loaded: true
            }))
          }
        ],
        // `loaded` stays false — the empty `messages` here says nothing about the
        // session, so the status write is skipped rather than clobbering it. A
        // prompt held through a FAILED load still runs: losing the transcript is
        // no reason to also lose what the operator just typed.
        onError: [
          { guard: "hasQueued", target: "running", actions: "dequeueTurn" },
          { target: "awaitingInput" }
        ]
      }
    },
    awaitingInput: {
      // Nothing is running here — this is the one place the session's persisted
      // status can be recorded truthfully. The live array may be re-windowed
      // here (no streaming message to disturb); the queued-turn path bypasses
      // this entry, so `refreshingDiff` fires the same trim for sessions that
      // settle straight into their next turn.
      //
      // Re-windowing here does not yank the transcript: a turn settles with the
      // view pinned to the bottom (its own stream scrolled there), the re-read tail
      // keeps the newest messages — the whole visible viewport — identical, and the
      // list keys rows by message id and re-pins to the last one on every `messages`
      // change (`conversation-view` sticky-bottom). Only the far-off-screen head is
      // dropped, and it pages back through "Load earlier".
      entry: ["persistSettledStatus", "requestHistoryTrim"],
      on: {
        // The re-read tail lands here or not at all: a new turn moves the machine
        // to `running`, where this event is unhandled and dropped. See `applyTrimmedTail`.
        HISTORY_TRIMMED: { actions: "applyTrimmedTail" },
        SESSION_EVENT_ENVELOPE: {
          guard: "isAcceptedStreamEnvelope",
          target: "remoteRunning",
          actions: ["beginRemoteTurn", "admitSessionEnvelope", "raiseSessionStream"]
        },
        SEND: [
          { guard: "canCoalesceExternalSend", actions: "coalesceExternalSend" },
          { target: "running", actions: "appendTurns" }
        ],
        // A queue parked by Stop survives into idle, so its rows' actions must
        // work here: "Send now" runs the picked message immediately (promote
        // unparks, then the ordinary dequeue starts the turn), and remove/edit
        // behave exactly as they do while running.
        SEND_NOW: {
          guard: "hasQueuedMessage",
          target: "running",
          actions: ["promoteQueued", "dequeueTurn"]
        },
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" },
        /**
         * The parked queue's release valve.
         *
         * A steer still in flight when the turn ended parks the queue here rather
         * than replaying it (see `hasSettledQueue`). Its reply is what decides:
         * `accepted` means the agent already has the message, so only what remains
         * behind it runs; anything else means it was never delivered, so it starts
         * its turn now — which is exactly the behaviour before the queue could steer.
         */
        STEER_RESULT: [
          {
            guard: "queueSurvivesSteer",
            target: "running",
            actions: ["settleLateSteer", "dequeueTurn"]
          },
          { actions: "settleLateSteer" }
        ],
        SET_MODE: { actions: "persistMode" },
        // Re-read the worktree diff on demand (e.g. after a revert from the rail).
        REFRESH_DIFF: { target: "refreshingDiff" }
      }
    },
    running: {
      invoke: {
        src: "agentStream",
        input: ({ context }) => ({
          sessionId: context.session.id,
          chatId: context.chatId,
          text: agentPrompt(context.pendingText, context.pendingAgentContext),
          displayText: context.pendingText,
          images: context.pendingImages,
          reasoning: context.reasoning,
          externalInstruction: context.pendingExternalInstruction
        })
      },
      on: {
        SESSION_EVENT_ENVELOPE: [
          {
            guard: "isAcceptedStreamEnvelope",
            actions: ["admitSessionEnvelope", "raiseSessionStream"]
          },
          {
            guard: "isAcceptedTerminalSessionEnvelope",
            target: "refreshingDiff",
            actions: "applySessionEnvelope"
          }
        ],
        STREAM_EVENT: [
          { guard: "isSessionSettled", actions: "applySettled" },
          {
            guard: "isDuplicateExternalAcceptance",
            target: "refreshingDiff",
            actions: ["acceptExternalInstruction", "discardDuplicateExternalTurn"]
          },
          { guard: "isExternalAcceptance", actions: "acceptExternalInstruction" },
          { guard: "isTerminal", target: "refreshingDiff", actions: "foldEvent" },
          // A tool just finished and something is waiting: hand it to the live
          // turn now rather than holding it until the turn ends. See `canAutoFlush`.
          {
            guard: "canAutoFlush",
            actions: ["foldEvent", "liveRefreshDiff", "autoFlushQueue"]
          },
          { actions: ["foldEvent", "liveRefreshDiff"] }
        ],
        // A live diff read resolved — reflect it in the Changes rail.
        DIFF_STAT_UPDATED: { actions: "applyLivePatch" },
        FILES_UPDATED: { actions: "applyLiveFiles" },
        // Sent mid-run: queued, then flushed into this turn at the next tool
        // boundary where the harness can take it (see `canAutoFlush`).
        SEND: [
          { guard: "canCoalesceExternalSend", actions: "coalesceExternalSend" },
          { actions: "enqueue" }
        ],
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" },
        // "Send now": interrupt the current turn and run the picked message next,
        // so the operator can steer mid-stream. Promote it to the head, then go
        // through `stopping` so the halt has landed before the next turn starts;
        // refreshingDiff dequeues it (the rest of the queue follows).
        SEND_NOW: [
          { guard: "canSteerQueued", actions: "promoteAndSteer" },
          // Hidden reference context cannot steer (the steer RPC has no field
          // for it), so "now" is honoured the only other way there is: stop the
          // turn and replay the message as the next Agent.run — the same
          // escalation a plain-text send-now takes on a steer-less harness.
          {
            guard: "sendNowNeedsFreshTurn",
            target: "stopping",
            actions: ["promoteQueued", "settleStoppedRun"]
          },
          // External feedback may be prioritised, but must dequeue through
          // Agent.run without interrupting the operator's turn: steering cannot
          // atomically persist its durable identity.
          { actions: "promoteQueued" }
        ],
        STEER_RESULT: [
          {
            // Only the OPERATOR's "send now" is allowed to escalate to a stop:
            // an automatic flush that the harness can't take stays queued and is
            // retried at the next boundary. See the `auto` flag on the event.
            guard: ({ event }) =>
              event.type === "STEER_RESULT" &&
              event.result.status === "unsupported" &&
              event.auto !== true,
            target: "stopping",
            actions: ["finishSteer", "settleStoppedRun"]
          },
          {
            guard: ({ event }) => event.result.status === "accepted",
            actions: "acceptSteer"
          },
          { actions: "finishSteer" }
        ],
        DECIDE_GATE: { actions: "optimisticGate" },
        ANSWER_QUESTION: { actions: "optimisticAnswer" },
        SET_MODE: { actions: "persistMode" },
        // Stopping PARKS the queue rather than clearing it — the operator asked
        // the agent to halt, not to destroy what they typed. The rows stay on
        // screen and inert until acted on (see `queueParked`). Live sub-agent
        // tabs still go (no completion events will arrive).
        STOP: {
          target: "stopping",
          actions: ["settleStoppedRun", "parkQueue", "clearSubagents"]
        }
      }
    },
    remoteRunning: {
      on: {
        SESSION_EVENT_ENVELOPE: [
          {
            guard: "isAcceptedStreamEnvelope",
            actions: ["admitSessionEnvelope", "raiseSessionStream"]
          },
          {
            guard: "isAcceptedTerminalSessionEnvelope",
            target: "refreshingDiff",
            actions: "applySessionEnvelope"
          }
        ],
        STREAM_EVENT: [
          { guard: "isTerminal", target: "refreshingDiff", actions: "foldEvent" },
          { actions: ["foldEvent", "liveRefreshDiff"] }
        ],
        SEND: { actions: "enqueue" },
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" },
        // A late steer reply can land here too (a session envelope moved the
        // machine while the RPC was in flight). Unhandled, `steeringId` latches
        // forever — see `settleLateSteer`.
        STEER_RESULT: { actions: "settleLateSteer" },
        DIFF_STAT_UPDATED: { actions: "applyLivePatch" },
        FILES_UPDATED: { actions: "applyLiveFiles" },
        SET_MODE: { actions: "persistMode" },
      }
    },
    /**
     * Waiting for a halt to actually land, before anything else may start a run.
     *
     * This state exists for one reason: the old code fired `agentStop` and
     * transitioned onward in the same breath, so the interrupt could arrive
     * after the next turn had already been forked and kill that instead. The
     * operator saw their new message answered with "Stopped.".
     *
     * Every exit leads to `refreshingDiff`, including the failure and timeout
     * arms — a stop that errors or hangs must never strand the machine in a
     * state with no composer.
     */
    stopping: {
      invoke: {
        src: "stopAgent",
        input: ({ context }) => ({
          sessionId: context.session.id,
          chatId: context.chatId
        }),
        onDone: { target: "refreshingDiff", actions: "settleStoppedFleet" },
        // A failed stop still means we are no longer streaming: the turn was
        // already settled by `settleStoppedRun` on the way in.
        onError: { target: "refreshingDiff" }
      },
      after: { [STOP_SETTLE_CAP]: { target: "refreshingDiff" } },
      on: {
        // Keep accepting sends — they run once the diff settles, as elsewhere.
        SEND: [
          { guard: "canCoalesceExternalSend", actions: "coalesceExternalSend" },
          { actions: "enqueue" }
        ],
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" },
        SEND_NOW: { actions: "promoteQueued" },
        // A steer's reply can outlive the turn it was aimed at. See `settleLateSteer`.
        STEER_RESULT: { actions: "settleLateSteer" },
        // The run is already being halted; a second STOP only parks the queue.
        STOP: { actions: ["parkQueue", "clearSubagents"] },
        DIFF_STAT_UPDATED: { actions: "applyLivePatch" },
        FILES_UPDATED: { actions: "applyLiveFiles" },
        SET_MODE: { actions: "persistMode" },
      }
    },
    // After a turn ends, re-read the worktree diff so the Changes rail reflects
    // whatever the agent actually edited.
    refreshingDiff: {
      // The OTHER settled turn boundary, and the only one a perpetually-busy
      // session ever visits: a queue that never drains routes every settle
      // through here straight back to `running`, bypassing `awaitingInput` —
      // which used to mean the live array was never re-windowed and grew one
      // whole turn per dequeue for as long as the operator kept feeding it.
      // The terminal event has folded (transition actions run before entry) and
      // main persists the settled turn before emitting it, so the same
      // disk-tail swap `awaitingInput` performs is sound here; a reply that
      // arrives after the next turn has moved us to `running` is dropped
      // there, exactly as before.
      entry: "requestHistoryTrim",
      invoke: {
        src: "refreshDiff",
        input: ({ context }) => ({ session: context.session }),
        // A queued message starts its turn as soon as the diff settles; otherwise
        // we return to idle. The diff is applied either way.
        onDone: [
          {
            guard: "hasSettledQueue",
            target: "running",
            actions: [
              assign(({ event }) => ({ diffStat: event.output, patchAt: Date.now() })),
              "dequeueTurn"
            ]
          },
          {
            target: "awaitingInput",
            actions: assign(({ event }) => ({ diffStat: event.output, patchAt: Date.now() }))
          }
        ],
        onError: [
          { guard: "hasSettledQueue", target: "running", actions: "dequeueTurn" },
          { target: "awaitingInput" }
        ]
      },
      on: {
        // Still accept queued sends while the diff refreshes (a brief window).
        SEND: [
          { guard: "canCoalesceExternalSend", actions: "coalesceExternalSend" },
          { actions: "enqueue" }
        ],
        UNQUEUE: { actions: "removeQueued" },
        EDIT_QUEUED: { actions: "editQueued" },
        // The turn already ended — just jump the picked message to the head so the
        // pending dequeue (on refresh settle) runs it next.
        SEND_NOW: { actions: "promoteQueued" },
        // The re-read tail from this state's own entry trim. Guarded inside the
        // action (cap re-check, in-flight history load) exactly as in
        // `awaitingInput`; if the diff settles first and a queued turn moves us
        // to `running`, the reply is unhandled there and dropped — safe.
        HISTORY_TRIMMED: { actions: "applyTrimmedTail" },
        // The most likely landing spot for a late steer reply: the turn's `Done`
        // moved us here while the RPC was still in flight. See `settleLateSteer`.
        STEER_RESULT: { actions: "settleLateSteer" },
        // A late live diff read may still resolve here — apply it (the authoritative
        // refresh's onDone runs last, so it wins).
        DIFF_STAT_UPDATED: { actions: "applyLivePatch" },
        FILES_UPDATED: { actions: "applyLiveFiles" },
        SET_MODE: { actions: "persistMode" },
      }
    }
  }
})

function recordFleetTombstone(
  tombstones: Map<string, Extract<SubagentFleetEvent, { _tag: "Remove" }>>,
  event: Extract<SubagentFleetEvent, { _tag: "Remove" }>,
  parentRuntimeSessionId: string
): void {
  if (parentRuntimeSessionId !== "" && !event.id.startsWith(`${parentRuntimeSessionId}/`)) return
  const current = tombstones.get(event.id)
  if (event.registryRevision >= (current?.registryRevision ?? -1)) {
    tombstones.delete(event.id)
    tombstones.set(event.id, event)
  }
}

function isNewerFleetSnapshot(
  event: Extract<SubagentFleetEvent, { _tag: "Snapshot" }>,
  latestSnapshot: Extract<SubagentFleetEvent, { _tag: "Snapshot" }> | null
): boolean {
  return (
    latestSnapshot === null ||
    event.snapshot.registryRevision > latestSnapshot.snapshot.registryRevision ||
    (event.snapshot.registryRevision === latestSnapshot.snapshot.registryRevision &&
      event.snapshot.generatedAt > latestSnapshot.snapshot.generatedAt)
  )
}

function fleetNodesForParent(
  event: Exclude<SubagentFleetEvent, { _tag: "Remove" }>,
  parentRuntimeSessionId: string
) {
  return event._tag === "Upsert"
    ? event.node.parentRuntimeSessionId === parentRuntimeSessionId ? [event.node] : []
    : event.snapshot.parentRuntimeSessionId === parentRuntimeSessionId ? event.snapshot.nodes : []
}

function foldMainStreamEvent(context: ConversationContext, e: StreamEvent) {
  const folded = patchLast(context.messages, (last) => applyStreamEvent(last, e))
  // A tool boundary is the moment a card can leave the recent window, so it
  // always triggers a parts walk. Without this a multi-hour turn
  // accumulates every settled card's output and previews on ONE message — a
  // shape no message-count trim can ever reach — and the actor holding it
  // is never evictable while running. The fold counter backstops turns
  // with no tool boundaries at all (pure reasoning, one long tool's
  // deltas), which otherwise never compact mid-turn. See
  // `transcript-compaction.ts` for what compaction keeps.
  const foldCount = context.foldsSinceCompaction + 1
  const compactDue = e._tag === "ToolEnd" || foldCount >= COMPACT_EVERY_N_FOLDS
  const foldsSinceCompaction = compactDue ? 0 : foldCount
  const messages = compactDue
    ? patchLast(folded, (last) => compactMessageParts(last))
    : folded
  // A finished/failed turn KEEPS its sub-agents (their tabs stay readable) —
  // any still marked "working" (e.g. an interrupted run, or a sub-agent whose
  // `task_notification` never arrived) settle to "done" so no tab shows a live
  // spinner. The spinner is driven by the message's `streaming` flag, NOT by
  // `status`, so the rolling message has to settle too — flipping the status
  // alone left the dots pulsing forever. The list resets when the next run
  // starts (`clearSubagents`). Keep a live context reading when one arrived;
  // Done's tokens are only a fallback for harnesses that report at turn end.
  const settled = context.subagents.map((s) =>
    s.status === "working"
      ? { ...s, status: "done" as const, message: settleStreaming(s.message) }
      : s
  )
  // `Done.tokens` NEVER reaches the context meter. It is the run's
  // cumulative spend (see the `Usage` schema note in conversation.ts) —
  // cache reads counted once per tool call — so on a long session it runs
  // to hundreds of millions. It used to be a fallback when the live
  // reading was 0, and the post-compaction reset made that 0 routine: the
  // meter then showed lifetime spend ("239239.4k context") until the next
  // turn's first Usage event corrected it. Occupancy comes from `Usage`
  // alone; a harness that only knows it at turn end must emit one.
  if (e._tag === "Done") {
    return {
      messages,
      foldsSinceCompaction,
      subagents: settled,
      runStartedAt: null,
      lastOutcome: "done" as const,
      pendingExternalInstruction: null,
      pendingExternalAcceptances: []
    }
  }
  if (e._tag === "Failed") {
    return {
      messages,
      foldsSinceCompaction,
      subagents: settled,
      runStartedAt: null,
      lastOutcome: "failed" as const,
      pendingExternalInstruction: null,
      pendingExternalAcceptances: []
    }
  }
  return { messages, foldsSinceCompaction }
}

function remoteDiffTotals(remote: Extract<SessionEventEnvelope["event"], { _tag: "DiffChanged" }>) {
  return remote.changes?.totals ??
    Object.values(remote.files ?? {}).reduce(
      (total, file) => ({
        added: total.added + file.added,
        removed: total.removed + file.removed
      }),
      { added: 0, removed: 0 }
    )
}

function recordTerminalFleetIds(terminalIds: Set<string>, nodes: ReturnType<typeof fleetNodesForParent>): void {
  for (const node of nodes) {
    if (node.nodeKind === "agent" && COMPLETED_FLEET_STATUSES.has(node.status)) {
      terminalIds.add(node.id)
    }
  }
}

function foldSubagentStream(context: ConversationContext, e: StreamEvent) {
  const next = applySubagentEvent(context.subagents, e)
  // Sub-agent rolling messages accrue the same heavy tool payloads as the
  // main turn but were invisible to compaction — a fleet-heavy turn held
  // every sub-agent's full outputs for the whole run. Compact them at the
  // same boundary the main path uses (a tool card leaving the window, or
  // the sub-agent settling), never per delta: `compactMessageParts` is
  // reference-preserving, so idle sub-agents keep identity and the tabs'
  // render comparators still short-circuit.
  if (e._tag !== "ToolEnd" && e._tag !== "SubagentEnded") {
    return { subagents: next }
  }
  return {
    subagents: next.map((s) => {
      const compacted = compactMessageParts(s.message)
      return compacted === s.message ? s : { ...s, message: compacted }
    })
  }
}
