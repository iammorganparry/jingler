/**
 * Thin view over `conversationMachine` — the deterministic conversation flow
 * lives in the chart (loading / awaitingInput / running), so this hook only maps
 * the current snapshot to props and events to sends.
 *
 * The actor itself is NOT owned by this hook: it lives in `conversation-registry`
 * so it outlives the pane (mounted keyed by the active session). Switching
 * sessions therefore detaches the view without stopping the run — the background
 * agent keeps working. Attaching to an existing actor also means switching back
 * shows its up-to-date state with no reload.
 */
import { useEffect, useMemo, useRef } from "react"
import { useSelector } from "@xstate/react"
import type {
  AgentEndpointId,
  AgentRuntimeId,
  Attachment,
  ContextBreakdown,
  GateDecision,
  Message,
  PermissionMode,
  PlannotatorProjection,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  QuestionAnswer,
  QuestionRequest,
  ReasoningSetting,
  ReviewPhase,
  Session,
  SessionStatus,
  Skill,
  Subagent,
  SubagentFleetControlOutcome,
  SubagentFleetEvent
} from "@jingler/core"
import { pendingQuestion } from "@jingler/core"
import type { QueuedMessage } from "./conversation-machine.js"
import { getConversationActor } from "./conversation-registry.js"
import { rpc } from "./rpc-client.js"

export interface Conversation {
  readonly messages: ReadonlyArray<Message>
  /** Older turns remain before `messages[0]` — show the "Load earlier" control. */
  readonly hasMoreHistory: boolean
  /** An older page is being fetched — disable the control and show a spinner. */
  readonly loadingHistory: boolean
  /** Page the next window of older turns onto the front of `messages`. */
  readonly loadOlder: () => void
  readonly mode: PermissionMode
  readonly reasoning?: ReasoningSetting
  readonly skills: ReadonlyArray<Skill>
  readonly files: ReadonlyArray<string>
  readonly runtimeId: AgentRuntimeId | null
  readonly endpointId: AgentEndpointId | null
  readonly connectionId: ProviderConnectionId | null
  readonly providerId: ProviderId | null
  readonly modelId: ProviderModelId | null
  readonly modelPending: boolean
  /** The worktree's current unified diff, for the Changes rail. */
  /** The agent is producing a turn (or paused at a gate). */
  readonly busy: boolean
  /** The agent is paused awaiting a HITL decision. */
  readonly paused: boolean
  /** Messages queued while the agent was busy (sent FIFO once it frees up). */
  readonly queued: ReadonlyArray<QueuedMessage>
  /**
   * The queued message currently being handed to the live turn, or null.
   *
   * It is still in `queued` (it only leaves once the harness confirms it), but it
   * is no longer the operator's to act on — the agent has it. Every row action
   * would otherwise run the same prompt a second time.
   */
  readonly steeringId: string | null
  /** Live sub-agents (harness `Task` spawns) for the current turn — watch-only tabs. */
  readonly subagents: ReadonlyArray<Subagent>
  readonly subagentFleetEvents: ReadonlyArray<SubagentFleetEvent>
  readonly subagentControlOutcomes: ReadonlyArray<SubagentFleetControlOutcome>
  /** Tokens currently occupying the main agent's context window. */
  readonly tokens: number
  readonly contextBreakdown: ContextBreakdown | null
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  readonly runStartedAt: number | null
  /**
   * Queue actions address a message by ITS ID, never by position: the automatic
   * flush removes the head mid-run, so an index captured when the row rendered can
   * point at a different message by the time the operator clicks.
   */
  readonly unqueue: (id: string) => void
  /** Steer supported live turns; otherwise interrupt and replay the queued message. */
  readonly sendNow: (id: string) => void
  /** Rewrite a queued message in place before it is ever sent. */
  readonly editQueued: (id: string, text: string) => void
  /** A pending AskUserQuestion group (the composer is replaced while set), or null. */
  readonly question: QuestionRequest | null
  readonly answerQuestion: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** Disposable native projection of Plannotator's authoritative state. */
  readonly plannotator: PlannotatorProjection | null
  /** Live status for the sidebar/tab bar, or null when idle (use persisted). */
  readonly status: SessionStatus | null
  readonly sendPrompt: (
    text: string,
    images?: ReadonlyArray<Attachment>,
    agentContext?: string
  ) => void
  readonly retryPrompt: (() => void) | null
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setReasoning: (reasoning?: ReasoningSetting) => void
  readonly setModel: (
    runtimeId: AgentRuntimeId,
    endpointId: AgentEndpointId,
    connectionId: ProviderConnectionId | undefined,
    providerId: ProviderId,
    modelId: ProviderModelId
  ) => void
  /**
   * The adversarial reviewer as a watch-only agent tab (null until one runs),
   * plus where it has got to and when it started — the PR button's live label.
   */
  readonly reviewer: Subagent | null
  readonly reviewPhase: ReviewPhase
  readonly reviewStartedAt: number | null
  readonly stop: () => void
  /** Kill one live sub-agent — its tab's ×. The turn and its siblings run on. */
  readonly stopSubagent: (agentId: string) => void
  /** Drop a settled sub-agent's tab (and its children's). Local only. */
  readonly closeSubagent: (agentId: string) => void
  /** Re-read the worktree diff (e.g. after reverting from the Changes rail). */
  readonly refreshDiff: () => void
}

export function useConversation(
  session: Session,
  chatId: string = session.activeChatId
): Conversation {
  const actor = useMemo(
    () => getConversationActor(session, chatId),
    [session.id, chatId]
  )
  useEffect(() => {
    actor.send({ type: "SESSION_UPDATED", session })
  }, [actor, session])
  // The comparator is the storm-breaker: the actor emits a fresh snapshot
  // OBJECT for every event, including ones whose transition assigns nothing —
  // and profiling showed those no-op emissions re-rendering the entire pane
  // (composer, chip menus, plan dock) continuously. Context is only replaced
  // by `assign`, and this machine's state values are flat strings, so
  // comparing those two identities keeps every render that could change
  // output and drops the rest.
  const state = useSelector(
    actor,
    (s) => s,
    (a, b) => a === b || (a.context === b.context && a.value === b.value)
  )
  const recoveryChecked = useRef<string | null>(null)
  useEffect(() => {
    if (!state.context.loaded || !session.chats.find(({ id }) => id === chatId)?.continuation) return
    const key = `${session.id}:${chatId}`
    if (recoveryChecked.current === key) return
    recoveryChecked.current = key
    let cancelled = false
    void rpc.agentPlannotatorRecoveryNeeded(session.id, chatId).then((needed) => {
      if (cancelled || !needed) return
      actor.send({ type: "SET_MODE", mode: "plan" })
      actor.send({ type: "SEND", text: "/plannotator-resume-review" })
    }).catch(() => {
      if (!cancelled) recoveryChecked.current = null
    })
    return () => {
      cancelled = true
    }
  }, [actor, chatId, session.chats, session.id, state.context.loaded])

  // Command callbacks, memoised per actor: `actor.send` never changes for a
  // given actor, so none of these need a fresh identity per snapshot. Their
  // stability is load-bearing for render cost — `MessageTurn` is memoised, and
  // a new `decideGate` on every streamed token would un-memo every visible
  // turn and rebuild the whole transcript per token.
  const commands = useMemo(
    () =>
      ({
        loadOlder: () => actor.send({ type: "LOAD_OLDER" }),
        unqueue: (id) => actor.send({ type: "UNQUEUE", id }),
        sendNow: (id) => actor.send({ type: "SEND_NOW", id }),
        editQueued: (id, text) => actor.send({ type: "EDIT_QUEUED", id, text }),
        sendPrompt: (text, images, agentContext) =>
          actor.send({ type: "SEND", text, images, agentContext }),
        decideGate: (gateId, decision) =>
          actor.send({ type: "DECIDE_GATE", gateId, decision }),
        answerQuestion: (requestId, answers) =>
          actor.send({ type: "ANSWER_QUESTION", requestId, answers }),
        setMode: (m) => actor.send({ type: "SET_MODE", mode: m }),
        setReasoning: (value) =>
          actor.send({ type: "SET_REASONING", reasoning: value }),
        setModel: (runtime, endpoint, connection, provider, selectedModel) =>
          actor.send({
            type: "SET_MODEL",
            runtimeId: runtime,
            endpointId: endpoint,
            connectionId: connection,
            providerId: provider,
            modelId: selectedModel
          }),
        stop: () => actor.send({ type: "STOP" }),
        stopSubagent: (agentId) => actor.send({ type: "STOP_SUBAGENT", agentId }),
        closeSubagent: (agentId) => actor.send({ type: "CLOSE_SUBAGENT", agentId }),
        refreshDiff: () => actor.send({ type: "REFRESH_DIFF" })
      }) satisfies Pick<
        Conversation,
        | "loadOlder"
        | "unqueue"
        | "sendNow"
        | "editQueued"
        | "sendPrompt"
        | "decideGate"
        | "answerQuestion"
        | "setMode"
        | "setReasoning"
        | "setModel"
        | "stop"
        | "stopSubagent"
        | "closeSubagent"
        | "refreshDiff"
      >,
    [actor, session.id]
  )
  const {
    messages, mode, reasoning, skills, files,
    runtimeId, endpointId, connectionId, providerId, modelId, modelPending, queued, steeringId,
    subagents, subagentFleetEvents, subagentControlOutcomes,
    tokens, contextBreakdown, hasMoreHistory, loadingHistory,
    runStartedAt, reviewer, reviewPhase, reviewStartedAt,
    plannotator
  } = state.context

  const paused = useMemo(() => {
    const last = messages[messages.length - 1]
    return (
      last?.role === "assistant" &&
      last.parts.some((p) => p._tag === "Gate" && p.gate.status === "pending")
    )
  }, [messages])

  const question = useMemo(() => pendingQuestion(messages), [messages])
  // Busy through the stop and the diff refresh too, so the composer keeps
  // queueing across the gap between a turn ending and the next queued turn
  // starting. `stopping` in particular is a state the operator often types
  // into — it is the moment right after they hit stop or "send now".
  const busy =
    state.matches("running") || state.matches("stopping") || state.matches("refreshingDiff")
  const status: SessionStatus | null =
    paused || question || plannotator?.review != null ? "needs-input" : busy ? "thinking" : null
  const retryPrompt =
    state.context.pendingText.length > 0 ||
    state.context.pendingImages.length > 0 ||
    state.context.pendingAgentContext.length > 0
      ? () => actor.send({
          type: "SEND",
          text: state.context.pendingText,
          images: state.context.pendingImages,
          agentContext: state.context.pendingAgentContext
        })
      : null

  return {
    ...commands,
    retryPrompt,
    messages,
    hasMoreHistory,
    loadingHistory,
    mode,
    reasoning,
    skills,
    files,
    runtimeId,
    endpointId,
    connectionId,
    providerId,
    modelId,
    modelPending,
    busy,
    paused,
    queued,
    steeringId,
    subagents,
    subagentFleetEvents,
    subagentControlOutcomes,
    tokens,
    contextBreakdown,
    runStartedAt,
    reviewer,
    reviewPhase,
    reviewStartedAt,
    question,
    plannotator: plannotator ?? null,
    status
  }
}
