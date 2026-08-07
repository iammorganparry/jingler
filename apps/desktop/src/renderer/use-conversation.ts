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
import { useEffect, useMemo } from "react"
import { useSelector } from "@xstate/react"
import type {
  Attachment,
  ExecutionMode,
  GateDecision,
  Message,
  CliKind,
  ProviderModels,
  PermissionMode,
  Plan,
  PlanAnnotationAnchor,
  PlanDocument,
  PlanDraft,
  PlanMentionDelivery,
  QuestionAnswer,
  QuestionRequest,
  ReasoningSetting,
  ReviewPhase,
  Session,
  SessionStatus,
  Skill,
  Subagent
} from "@jingler/core"
import { latestPlan, pendingPlan, pendingQuestion } from "@jingler/core"
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
  /**
   * The session's live harness + model, and the catalogue of every installed
   * harness's models. `cli` can change mid-session, so read it from here rather
   * than off the `Session` the hook was called with.
   */
  readonly cli: CliKind
  readonly model: string
  readonly catalog: ReadonlyArray<ProviderModels>
  /** The worktree's current unified diff, for the Changes rail. */
  readonly patch: string
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
  /** Tokens currently occupying the main agent's context window. */
  readonly tokens: number
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
  /** The latest open plan (proposed / revising), for the Plan Review tab, or null. */
  readonly plan: Plan | null
  /** Sanitized, cumulative plan source that has not been promoted yet. */
  readonly planDraft: PlanDraft | null
  /** Changes once per planning turn when its first renderable draft arrives. */
  readonly planDraftPresentationNonce: number
  /** A rejected exact-revision approval, shown in the Plan workspace. */
  readonly planActionError: string | null
  readonly commentPlanStep: (
    planId: string,
    stepId: string,
    body: string,
    anchor?: PlanAnnotationAnchor
  ) => void
  readonly dispatchPlanMessage: (input: {
    readonly planId: string
    readonly baseRevision: number
    readonly annotationId: string
    readonly body: string
    readonly authorId: string
    readonly mentionedParticipantIds: ReadonlyArray<string>
  }) => Promise<{
    readonly document: PlanDocument
    readonly messageId: string
    readonly deliveries: ReadonlyArray<PlanMentionDelivery>
  }>
  readonly revisePlan: (planId: string) => void
  readonly approvePlan: (
    planId: string,
    executionMode?: ExecutionMode,
    revision?: number
  ) => void
  readonly resumePlan: (planId: string, revision?: number) => void
  /** Live status for the sidebar/tab bar, or null when idle (use persisted). */
  readonly status: SessionStatus | null
  readonly sendPrompt: (
    text: string,
    images?: ReadonlyArray<Attachment>,
    agentContext?: string
  ) => void
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setReasoning: (reasoning?: ReasoningSetting) => void
  /** Picking a model implies its harness, so both are set together. */
  readonly setHarness: (cli: CliKind, model: string) => void
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
  const state = useSelector(actor, (s) => s)
  const send = actor.send
  const {
    messages, mode, reasoning, skills, files, cli, model, catalog, patch, queued, steeringId,
    subagents, tokens, hasMoreHistory, loadingHistory,
    runStartedAt, reviewer, reviewPhase, reviewStartedAt,
    planDraft, planDraftPresentationNonce
  } = state.context

  const paused = useMemo(() => {
    const last = messages[messages.length - 1]
    return (
      last?.role === "assistant" &&
      last.parts.some((p) => p._tag === "Gate" && p.gate.status === "pending")
    )
  }, [messages])

  const question = useMemo(() => pendingQuestion(messages), [messages])
  // `plan` (any status) drives the Plan Review view; `openPlan` (proposed/revising)
  // drives the actionable "needs-input" status.
  const plan = useMemo(() => latestPlan(messages), [messages])
  const openPlan = useMemo(() => pendingPlan(messages), [messages])
  // Busy through the stop and the diff refresh too, so the composer keeps
  // queueing across the gap between a turn ending and the next queued turn
  // starting. `stopping` in particular is a state the operator often types
  // into — it is the moment right after they hit stop or "send now".
  const busy =
    state.matches("running") || state.matches("stopping") || state.matches("refreshingDiff")
  const status: SessionStatus | null =
    paused || question || openPlan ? "needs-input" : busy ? "thinking" : null

  return {
    messages,
    hasMoreHistory,
    loadingHistory,
    loadOlder: () => send({ type: "LOAD_OLDER" }),
    mode,
    reasoning,
    skills,
    files,
    cli,
    model,
    catalog,
    patch,
    busy,
    paused,
    queued,
    steeringId,
    subagents,
    tokens,
    runStartedAt,
    reviewer,
    reviewPhase,
    reviewStartedAt,
    unqueue: (id) => send({ type: "UNQUEUE", id }),
    sendNow: (id) => send({ type: "SEND_NOW", id }),
    editQueued: (id, text) => send({ type: "EDIT_QUEUED", id, text }),
    question,
    plan,
    planDraft,
    planDraftPresentationNonce,
    planActionError: state.context.planActionError,
    commentPlanStep: (planId, stepId, body, anchor) =>
      send({ type: "COMMENT_PLAN_STEP", planId, stepId, body, ...(anchor ? { anchor } : {}) }),
    dispatchPlanMessage: (input) =>
      rpc.planDispatchMessage({ sessionId: session.id, ...input }),
    revisePlan: (planId) => send({ type: "REVISE_PLAN", planId }),
    approvePlan: (planId, executionMode, revision) =>
      send({ type: "APPROVE_PLAN", planId, executionMode, revision }),
    resumePlan: (planId, revision) => send({ type: "RESUME_PLAN", planId, revision }),
    status,
    sendPrompt: (text, images, agentContext) => send({ type: "SEND", text, images, agentContext }),
    decideGate: (gateId, decision) => send({ type: "DECIDE_GATE", gateId, decision }),
    answerQuestion: (requestId, answers) => send({ type: "ANSWER_QUESTION", requestId, answers }),
    setMode: (m) => send({ type: "SET_MODE", mode: m }),
    setReasoning: (value) => send({ type: "SET_REASONING", reasoning: value }),
    setHarness: (c, m) => send({ type: "SET_HARNESS", cli: c, model: m }),
    stop: () => send({ type: "STOP" }),
    stopSubagent: (agentId) => send({ type: "STOP_SUBAGENT", agentId }),
    closeSubagent: (agentId) => send({ type: "CLOSE_SUBAGENT", agentId }),
    refreshDiff: () => send({ type: "REFRESH_DIFF" })
  }
}
