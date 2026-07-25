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
  QuestionAnswer,
  QuestionRequest,
  ReasoningSetting,
  ReviewPhase,
  Session,
  SessionStatus,
  Skill,
  Subagent
} from "@starbase/core"
import { latestPlan, pendingPlan, pendingQuestion } from "@starbase/core"
import type { QueuedMessage } from "./conversation-machine.js"
import { getConversationActor } from "./conversation-registry.js"

export interface Conversation {
  readonly messages: ReadonlyArray<Message>
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
  readonly commentPlanStep: (planId: string, stepId: string, body: string) => void
  readonly revisePlan: (planId: string) => void
  readonly approvePlan: (planId: string, executionMode?: ExecutionMode) => void
  readonly resumePlan: (planId: string) => void
  /** Live status for the sidebar/tab bar, or null when idle (use persisted). */
  readonly status: SessionStatus | null
  readonly sendPrompt: (text: string, images?: ReadonlyArray<Attachment>) => void
  readonly decideGate: (gateId: string, decision: GateDecision) => void
  readonly setMode: (mode: PermissionMode) => void
  readonly setReasoning: (reasoning?: ReasoningSetting) => void
  /** Whether an adversarial planning round can run, and the reason when it can't. */
  readonly adversarialPlanning: { readonly ready: boolean; readonly reason: string | null } | null
  /** Hand the durable Gigaplan intake thread to the adversarial planners. */
  readonly handoffPlan: () => void
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
    messages, mode, reasoning, skills, files, cli, model, catalog, patch, queued, subagents, tokens,
    runStartedAt, reviewer, reviewPhase, reviewStartedAt
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
    commentPlanStep: (planId, stepId, body) => send({ type: "COMMENT_PLAN_STEP", planId, stepId, body }),
    revisePlan: (planId) => send({ type: "REVISE_PLAN", planId }),
    approvePlan: (planId, executionMode) => send({ type: "APPROVE_PLAN", planId, executionMode }),
    resumePlan: (planId) => send({ type: "RESUME_PLAN", planId }),
    status,
    sendPrompt: (text, images) => send({ type: "SEND", text, images }),
    decideGate: (gateId, decision) => send({ type: "DECIDE_GATE", gateId, decision }),
    answerQuestion: (requestId, answers) => send({ type: "ANSWER_QUESTION", requestId, answers }),
    setMode: (m) => send({ type: "SET_MODE", mode: m }),
    setReasoning: (value) => send({ type: "SET_REASONING", reasoning: value }),
    adversarialPlanning: state.context.planReadiness,
    handoffPlan: () => send({ type: "HANDOFF_PLAN" }),
    setHarness: (c, m) => send({ type: "SET_HARNESS", cli: c, model: m }),
    stop: () => send({ type: "STOP" }),
    refreshDiff: () => send({ type: "REFRESH_DIFF" })
  }
}
