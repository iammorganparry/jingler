import { randomUUID } from "node:crypto"
import type {
  ApprovalGate,
  Attachment,
  CliKind,
  ContentPart,
  ExecutionMode,
  ExternalInstructionIdentity,
  GateDecision,
  Message,
  PermissionMode,
  Plan,
  PlanApprovalResult,
  PlanComment,
  PlanParticipant,
  PlanPrdStage,
  QuestionAnswer,
  QuestionRequest,
  ReasoningSetting,
  Session,
  StreamEvent
} from "@jingler/core"
import {
  ADHD_MODE_DEFAULT,
  applyStreamEvent,
  assistantMessage,
  buildPlanExecutionGraph,
  CliExecError,
  compileOrchestrationPlan,
  defaultModeFor,
  defaultModel,
  findApprovedPlan,
  isBackgroundTaskEvent,
  isSubagentEvent,
  ORCHESTRATOR_ENABLED_DEFAULT,
  planDocumentToPlan,
  orchestratorParticipantRoutingId,
  PLAN_AUTO_RUN_DEFAULT,
  subagentParticipantRoutingId,
  resumePlanPrompt,
  setQuestionAnswers,
  settleStreaming,
  STOPPED_NOTE,
  stripPlanResultProtocol,
  supportsPlanMode,
  userMessage,
  workspaceModeOf,
  type PlanPrd,
  resolveWorkerRoutingConfig,
  workerRoutingMismatch
} from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Cause, Deferred, Effect, Fiber, Mailbox, Option, Ref, Stream } from "effect"
import { adhdNote } from "./adhd-prompt.js"
import { orchestratorNote, orchestratorTurnPrompt } from "./orchestrator-prompt.js"
import { parseOrchestratorAmendment, stripOrchestratorAmendment } from "./orchestrator-amend.js"
import { modeOnApproval, modeToRestore } from "./exec-mode.js"
import { isTerminal, routeOf } from "./turn-events.js"
import {
  composeTurnPrompt,
  leadsWithCommand,
  planPointerNote
} from "./turn-prompt.js"
import { buildGate, makeApprovals, verdict } from "./approvals.js"
import { runLifetime } from "./run-lifetime.js"
import { planNote } from "./plan-prompt.js"
import { capturePlanEmission, stripPlanJsonBlock } from "./plan-json.js"
import { questionNote } from "./question-prompt.js"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { CliAdapter, PlanDecision } from "./adapter.js"
import type {
  OrchestrationRoute,
  PermissionDecision,
  PermissionRequest,
  RemoteMcpServer,
  SessionSpec,
  PlanParticipantSteerResult,
  SteerTurn,
  StopBackgroundTask
} from "./adapter.js"
import { ContextManager } from "./context-manager.js"
import { renderPrimer, tailAfter } from "./context-digest.js"
import { readDefaultMode } from "./default-mode.js"
import { DiscoveryService } from "./discovery.js"
import { ModelsService } from "./models.js"
import { healedWorktreePath } from "./cli-project-dir.js"
import { branchAt, ensureWorktreeLinked } from "./git.js"
import { OpenConnectorService } from "./open-connector.js"
import { BrowserControlMcpService } from "./browser-control-mcp-service.js"
import { remoteMcpServer } from "./mcp-config.js"
import {
  EMPTY_MEMORY_RETRIEVAL_SUMMARY,
  MemoryService,
  MemoryServiceLive,
  recordMemoryRetrieval
} from "./memory.js"
import type { SecretStore } from "./secret-store.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { PlanStore } from "./plan-store.js"
import { resolveAnnotations } from "./plan-mutations.js"
import {
  appendSteeredReply,
  collectSteeredReply,
  invokeSteer,
  makeSteeredReplyWaiter,
  type SteeredReplyWaiter
} from "./steered-reply.js"
import type { RunHolder } from "./run-coordinator.js"
import {
  anySessionRunActive,
  reclaimSessionRun,
  releaseSessionRun,
  reserveSessionRun
} from "./run-coordinator.js"

/** Tools that write to disk — a successful one advances the matching plan step. */
const EDIT_TOOLS = new Set(["Write", "Edit", "Update", "MultiEdit", "NotebookEdit"])

const approvalAccepted: PlanApprovalResult = { status: "accepted" }
const approvalRefused = (
  message: string,
  latestRevision: number
): PlanApprovalResult => ({
  status: "refused",
  message,
  latestRevision
})
const failedStream = (message: string): Stream.Stream<StreamEvent> => {
  const event: StreamEvent = { _tag: "Failed", message }
  return Stream.make(event)
}

/** Keep planner advertisement and approval validation on one live route set. */
export const planningOrchestrationRoutes = (
  catalog: ReadonlyArray<OrchestrationRoute>
): ReadonlyArray<OrchestrationRoute> =>
  catalog.filter((provider) => supportsPlanMode(provider.cli))

export const unavailableOrchestrationAssignment = (
  stages: ReadonlyArray<PlanPrdStage>,
  routes: ReadonlyArray<OrchestrationRoute>
): PlanPrdStage | null => {
  const available = new Map(
    routes.map((provider) => [
      provider.cli,
      new Set(provider.models.map((model) => model.id))
    ])
  )
  return stages.find(
    (stage) =>
      stage.assignment !== null &&
      stage.assignment !== undefined &&
      !available.get(stage.assignment.cli)?.has(stage.assignment.model)
  ) ?? null
}

export interface PlanEvidenceMarker {
  readonly criterionId: string
  readonly status: "passed" | "failed"
  readonly evidence: string
}

/** Parse the deliberately line-oriented evidence protocol from an agent reply. */
export const planEvidenceFromText = (text: string): ReadonlyArray<PlanEvidenceMarker> =>
  text.split(/\r?\n/).flatMap((line) => {
    const match =
      /^\s*PLAN_RESULT\s+criterion=(\S+)\s+status=(passed|failed)\s+evidence=(\S[\s\S]*?)\s*$/.exec(
        line
      )
    return match === null
      ? []
      : [
          {
            criterionId: match[1]!,
            status: match[2]! as "passed" | "failed",
            evidence: match[3]!
          }
        ]
  })

/**
 * How long `stop` waits for an interrupted run to finish unwinding before it
 * gives up the session lock.
 *
 * Not a deadline on the interrupt — that is already delivered — only on our
 * WAIT for it. The Claude adapter grants itself 15s to tear a child down, and a
 * stop that held the lock for all of it would leave the operator's next message
 * sitting unanswered for fifteen seconds, which is the very symptom this whole
 * change exists to remove. Five seconds covers an ordinary teardown; past that
 * we would rather overlap than stall.
 */
const INTERRUPT_GRACE = "5 seconds"

/**
 * How long a turn may produce NOTHING before we declare the harness wedged.
 *
 * Nothing else in the stack bounds this. `AgentRunner.prompt` has no timeout,
 * `Effect.ensuring(out.end)` only runs once `adapter.run` returns, and the
 * Claude adapter's `for await` over the SDK stream is unbounded — so a child
 * that hangs before its `system/init` line is invisible everywhere, and the
 * turn's placeholder message stays empty with `streaming: true` forever. That
 * is the spinning-eyebrow-with-no-reply bug; 32 of 946 assistant turns in
 * ~/jingler/transcripts are stuck in exactly that state.
 *
 * Generous on purpose. This is the wait for the FIRST event, not for the
 * answer: harness startup, MCP server boot and a cold resume all land well
 * inside two minutes, and a false trip costs the operator real work.
 */
const FIRST_EVENT_DEADLINE = "120 seconds"

/**
 * Whether a harness failure means the resident conversation can no longer fit.
 *
 * Keep this deliberately narrow: ordinary provider errors must not spend a
 * second model call building a digest. These phrases cover Codex's app-server
 * wording plus the standard API variants used by the other adapters.
 */
export const isContextOverflowFailure = (message: string): boolean =>
  /ran out of room[^.]*context window|maximum context length|context window[^.]*\b(?:exceed(?:ed|s)?|exhausted|full|too (?:large|long))\b|too many tokens/i.test(
    message
  )


/** An opaque per-run identity — object identity is the whole point. */
type RunToken = Record<never, never>

/** A session's in-flight run: the fiber to interrupt, and which run owns the slot. */
interface RunFiber {
  readonly sessionId: string
  readonly chatId: string
  readonly fiber: Fiber.RuntimeFiber<void, never>
  readonly token: RunToken
  /**
   * Whether this run has already emitted its terminal event.
   *
   * A live fiber does NOT mean a live turn. The real Claude adapter's `for await`
   * over the SDK never breaks on `result`, so a run keeps consuming after `Done`
   * for as long as a background task keeps the session open — minutes or hours.
   * Single-flight is about TURNS, so the refusal has to read this rather than
   * fiber liveness, or a backgrounded task locks its chat for its whole lifetime.
   */
  readonly settled: Ref.Ref<boolean>
}

/**
 * Live handles onto the in-flight run for a session, so the out-of-band plan RPCs
 * (comment / revise / approve) can read + mutate the plan part in the current
 * assistant turn — updating both the live accumulator and the persisted
 * transcript, and pushing a `PlanUpdated` so an attached renderer stays in sync.
 */
interface ActiveRun {
  readonly readPlan: (planId: string) => Effect.Effect<Plan | null>
  readonly applyPlan: (planId: string, f: (plan: Plan) => Plan) => Effect.Effect<void>
  readonly markPlanExecution: (planId: string) => Effect.Effect<void>
  readonly steer: (
    text: string,
    images: ReadonlyArray<Attachment>,
    captureReply?: boolean
  ) => Effect.Effect<
    | {
        readonly status: "accepted"
        readonly user: Message
        readonly assistant: Message
        readonly replyWaiter: RunReplyWaiter | null
      }
    | { readonly status: "deferred" | "unsupported" }
  >
  readonly subagents: () => Effect.Effect<ReadonlyArray<PlanParticipant>>
  readonly clearReplyWaiter: (waiter: RunReplyWaiter) => Effect.Effect<void>
  readonly replyGate: Effect.Semaphore
}

/** Result of inspecting and applying one approved-plan orchestrator reply. */
export type OrchestratorAmendmentOutcome =
  | {
      readonly status: "applied"
      readonly currentRevision: number
      readonly diagnostics: readonly []
    }
  | {
      readonly status: "not-present"
      readonly currentRevision: number | null
      readonly diagnostics: readonly []
    }
  | {
      readonly status: "invalid" | "conflict"
      readonly currentRevision: number | null
      readonly diagnostics: ReadonlyArray<string>
    }

/** Durable feedback shown after an amendment could not become canonical. */
export const orchestratorAmendmentOutcomeText = (
  outcome: OrchestratorAmendmentOutcome
): string | null =>
  outcome.status === "invalid" || outcome.status === "conflict"
    ? [
        `Jingler amendment outcome: ${outcome.status}.`,
        `Current canonical revision: ${outcome.currentRevision ?? "unavailable"}.`,
        ...outcome.diagnostics
      ].join(" ")
    : null

const amendmentNotPresent = (
  currentRevision: number | null
): OrchestratorAmendmentOutcome => ({
  status: "not-present",
  currentRevision,
  diagnostics: []
})

const amendmentFailure = (
  status: "invalid" | "conflict",
  currentRevision: number | null,
  diagnostics: ReadonlyArray<string>
): OrchestratorAmendmentOutcome => ({
  status,
  currentRevision,
  diagnostics
})

const amendmentApplied = (
  currentRevision: number
): OrchestratorAmendmentOutcome => ({
  status: "applied",
  currentRevision,
  diagnostics: []
})

const PLAN_HTML_SUBMISSION_OPENING = /(?:^|\n)````html[ \t]*(?:\r?\n|$)/i

type RunReplyWaiter = SteeredReplyWaiter

/** Windows separators → POSIX, so path comparison has one shape to reason about. */
const normalizePath = (p: string): string => p.replace(/\\/g, "/")

/**
 * Do two paths name the same file? One side is typically an absolute worktree
 * path (the tool's edit target), the other a repo-relative path (a plan step's
 * declared `files:`), so a suffix match is right — but ONLY anchored at a
 * separator. An unanchored `endsWith` makes "a.ts" match "src/schema.ts" and
 * ticks a step that had nothing to do with the edit.
 */
const samePath = (a: string, b: string): boolean =>
  a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)

const findPlan = (msg: Message, planId: string): Plan | null => {
  for (const p of msg.parts) if (p._tag === "Plan" && p.plan.id === planId) return p.plan
  return null
}

/** Bundle the operator's un-routed step comments into a plain revision instruction. */
const revisionText = (plan: Plan, comments: ReadonlyArray<PlanComment>): string => {
  const lines = [
    "I've reviewed the plan. Please revise it to address these comments, then call ExitPlanMode again with the updated plan:"
  ]
  for (const c of comments) {
    const step = plan.steps.find((s) => s.id === c.stepId)
    const where = step ? `Step ${step.number} (${step.title})` : "General"
    lines.push(`- ${where}: ${c.body}`)
  }
  return lines.join("\n")
}

type PromptEnv =
  | CliAdapter
  | ConfigService
  | SessionStore
  | TranscriptStore
  | BackgroundTaskStore
  | PlanStore
  | DiscoveryService
  | ContextManager
  | OpenConnectorService
  | BrowserControlMcpService
  | SecretStore
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

/**
 * Compose main-only launch attachments in stable priority order.
 *
 * Keeping the first occurrence makes duplicate inputs deterministic. Callers
 * put Jingler-owned attachments first so an operator connector cannot shadow a
 * credential-bound internal service by claiming its reserved name.
 */
export const composeRemoteMcpServers = (
  ...entries: ReadonlyArray<RemoteMcpServer | null>
): ReadonlyArray<RemoteMcpServer> => {
  const names = new Set<string>()
  const attachments: RemoteMcpServer[] = []
  for (const entry of entries) {
    if (entry === null || names.has(entry.name)) continue
    names.add(entry.name)
    attachments.push(entry)
  }
  return attachments
}

/**
 * Orchestrates a prompt against the selected harness. `prompt` returns a
 * `Stream<StreamEvent>` — the harness-agnostic seam the renderer subscribes to —
 * while, in-band, it applies the session's HITL mode, pauses on gates, folds each
 * event into the persisted transcript, and re-emits it. Gate/mode state lives in
 * this singleton service so `decideGate`/`setMode` (separate RPCs) can reach the
 * paused run.
 */
export class AgentRunner extends Effect.Service<AgentRunner>()("@jingler/AgentRunner", {
  dependencies: [ModelsService.Default, MemoryServiceLive],
  effect: Effect.gen(function* () {
    const modelsService = yield* ModelsService
    const memoryService = yield* MemoryService
    // gateId → the pending gate (shared across prompt/decideGate/stop calls).
    /** Human-in-the-loop state, and the rule that decides what needs approval. */
    const approvals = yield* makeApprovals
    // requestId → the pending question group (shared across prompt/answerQuestion/stop).
    // Per-chat live HITL state, seeded from the Chat record on first use.
    const modes = yield* Ref.make(new Map<string, PermissionMode>())
    // planId → the pending plan (shared across prompt/approve/revise/stop).
    // chatId → the exec mode to restore when a plan is approved (captured on
    // the switch into "plan").
    const priorModes = yield* Ref.make(new Map<string, PermissionMode>())
    // chatId → the user's default exec mode (read from their claude/codex
    // config at run start). Used as the restore fallback when there's no prior
    // exec mode to fall back to — so approving a plan lands in the mode they
    // normally run in, not a hardcoded guess.
    const execDefaults = yield* Ref.make(new Map<string, PermissionMode>())
    // chatId → live handles onto the current run, for the out-of-band plan RPCs.
    const active = yield* Ref.make(new Map<string, ActiveRun>())
    // chatId → the fiber running the agent, so `stop` can interrupt it.
    // Interruption is the ONLY thing that reaches the underlying process: the
    // real adapter aborts its CLI in an `onInterrupt` finalizer. Nothing else
    // gets there — `CliAdapter.stop` is a no-op in every implementation, and a
    // client hanging up its stream does NOT tear the run down (verified: the run
    // survives its consumer). Without this handle a "stopped" agent keeps running.
    const fibers = yield* Ref.make(new Map<string, RunFiber>())
    // chatId → a mutex serialising `stop` against `prompt`'s SETUP.
    //
    // Without it, a stop and the next turn race for the same `fibers` slot, and
    // the stop loses: the renderer fires `agentStop` and moves on, `prompt`
    // forks and registers run B over run A's entry, and only THEN does the
    // stop's `Ref.get` schedule — handing it run B's fiber to kill. The operator
    // sees their fresh message answered with a bare "Stopped." and re-sends.
    // (64 of 946 assistant turns in ~/jingler/transcripts are exactly that.)
    //
    // A token check alone cannot fix it: by the time the stop reads the map, the
    // only entry that ever existed for that read IS run B's. The read and the
    // registration have to be ordered, which is what this lock does.
    //
    // Keyed by chatId, NOT sessionId: the `fibers` slot it protects is per-chat,
    // so two chats in the same session must not serialise against each other —
    // that is exactly the concurrency this feature enables.
    const locks = yield* Ref.make(new Map<string, Effect.Semaphore>())
    /** The chat's mutex, created on first use. */
    const chatLock = (chatId: string) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(locks)).get(chatId)
        if (existing !== undefined) return existing
        const made = yield* Effect.makeSemaphore(1)
        // `Ref.modify` is atomic, so two concurrent first-users agree on one
        // semaphore — the loser's freshly made one is simply dropped.
        return yield* Ref.modify(locks, (m) => {
          const current = m.get(chatId)
          return current !== undefined ? [current, m] : [made, new Map(m).set(chatId, made)]
        })
      })

    // Monotonic id source — deterministic (no Date.now/random) for stable tests.
    const counter = yield* Ref.make(0)
    const nextId = Ref.updateAndGet(counter, (n) => n + 1)

    const persistMode = (sessionId: string, chatId: string, mode: PermissionMode) =>
      SessionStore.setMode(sessionId, chatId, mode).pipe(Effect.ignore)

    /** A session by id, or null when it isn't in the store (never fails). */
    const getSessionOrNull = (sessionId: string) =>
      SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))

    const setMode = (
      sessionId: string,
      chatIdOrMode: string,
      maybeMode?: PermissionMode
    ) =>
      Effect.gen(function* () {
        const chatId = maybeMode === undefined ? sessionId : chatIdOrMode
        const mode = (maybeMode ?? chatIdOrMode) as PermissionMode
        // Entering plan mode: remember the exec mode to fall back to on approval.
        if (mode === "plan") {
          const current =
            (yield* Ref.get(modes)).get(chatId) ??
            (yield* getSessionOrNull(sessionId))?.chats.find((chat) => chat.id === chatId)?.mode
          const prior = modeToRestore(current, (yield* Ref.get(execDefaults)).get(chatId))
          yield* Ref.update(priorModes, (m) => new Map(m).set(chatId, prior))
        }
        yield* Ref.update(modes, (m) => new Map(m).set(chatId, mode))
        // Plan mode is TRANSIENT — never persist it to the session. If we did, a
        // restart (or any run with an empty in-memory `modes`) would resurrect
        // plan mode from `session.mode` with no `priorModes` captured, so
        // approving the plan would fall back to "accept-edits" and re-gate every
        // command. Keeping the real exec mode persisted means `session.mode` is
        // always the mode to restore on approval.
        if (mode !== "plan") yield* persistMode(sessionId, chatId, mode)
      })

    const decideGate = (
      sessionId: string,
      chatIdOrGateId: string,
      gateIdOrDecision: string,
      maybeDecision?: GateDecision
    ) =>
      Effect.gen(function* () {
        const chatId = maybeDecision === undefined ? sessionId : chatIdOrGateId
        const gateId = maybeDecision === undefined ? chatIdOrGateId : gateIdOrDecision
        const decision = maybeDecision ?? (gateIdOrDecision as GateDecision)
        // The registry owns the in-memory allowlist and hands back the token to
        // persist, so the durable write stays here with the rest of the session
        // state and `approvals` stays free of `SessionStore`.
        const label = yield* approvals.decide(sessionId, chatId, gateId, decision)
        if (label !== null) {
          yield* SessionStore.addAllowlist(sessionId, chatId, label).pipe(Effect.ignore)
        }
      })

    /** Submit the user's answers to a pending question group, resuming the agent. */
    const answerQuestion = (
      sessionId: string,
      chatIdOrRequestId: string,
      requestIdOrAnswers: string | ReadonlyArray<QuestionAnswer>,
      maybeAnswers?: ReadonlyArray<QuestionAnswer>
    ) =>
      Effect.gen(function* () {
        const chatId = maybeAnswers === undefined ? sessionId : chatIdOrRequestId
        const requestId =
          maybeAnswers === undefined ? chatIdOrRequestId : (requestIdOrAnswers as string)
        const answers =
          maybeAnswers ?? (requestIdOrAnswers as ReadonlyArray<QuestionAnswer>)
        yield* approvals.answer(sessionId, chatId, requestId, answers)
      })

    /** Resolve a session's pending plan (guards session ownership). */
    const resolvePlan = (sessionId: string, planId: string, decision: PlanDecision) =>
      approvals.settlePlan(sessionId, planId, decision)

    /**
     * A pending plan (by id) and its live run, gated on session ownership — the
     * lookup the comment / revise / approve handlers all begin with. `run` is
     * undefined when the plan isn't this session's or its run has already gone.
     */
    const pendingPlanRun = (sessionId: string, planId: string) =>
      Effect.gen(function* () {
        const pending = yield* approvals.pendingPlan(planId)
        const run =
          pending?.sessionId === sessionId
            ? (yield* Ref.get(active)).get(pending.chatId)
            : undefined
        return { pending, run } as const
      })

    const canonicalPlan = (sessionId: string, planId: string) =>
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId).pipe(
          Effect.orElseSucceed(() => null)
        )
        if (session?.worktreePath == null) return null
        const document = yield* PlanStore.readDocument(
          session.worktreePath,
          session.id,
          session.activeChatId
        )
        return document?.id === planId
          ? { document, worktreePath: session.worktreePath }
          : null
      })

    /**
     * Locate the live main-agent run that owns this plan. Pending plans use the
     * approval registry; executing plans fall back to the canonical producing
     * chat so orchestrator amendments remain addressable.
     */
    const addressablePlanRun = (sessionId: string, planId: string) =>
      Effect.gen(function* () {
        const pending = yield* pendingPlanRun(sessionId, planId)
        if (pending.run !== undefined) {
          return {
            chatId: pending.pending!.chatId,
            run: pending.run,
            lifecycle: "parked"
          } as const
        }
        const canonical = yield* canonicalPlan(sessionId, planId)
        if (canonical === null) return null
        const run = (yield* Ref.get(active)).get(
          canonical.document.producingChatId
        )
        return run === undefined
          ? null
          : {
              chatId: canonical.document.producingChatId,
              run,
              lifecycle: "running"
            } as const
      })

    const planParticipants = (
      sessionId: string,
      planId: string
    ) =>
      Effect.gen(function* () {
        const addressable = yield* addressablePlanRun(sessionId, planId)
        if (addressable === null) return []
        const orchestrator = {
          routingId: orchestratorParticipantRoutingId(addressable.chatId),
          displayName: "Orchestrator",
          role: "orchestrator",
          lifecycle: addressable.lifecycle,
          ownerRoutingId: null
        } satisfies PlanParticipant
        return [
          orchestrator,
          ...(yield* addressable.run.subagents())
        ]
      })

    const steerPlanParticipant = (request: {
      readonly sessionId: string
      readonly planId: string
      readonly routingId: string
      readonly text: string
    }) =>
      Effect.gen(function* () {
        const addressable = yield* addressablePlanRun(
          request.sessionId,
          request.planId
        )
        if (addressable === null) {
          return {
            status: "unavailable",
            detail:
              `Participant "${request.routingId}" is no longer active. ` +
              "Refresh the participant list before retrying or rerouting."
          } satisfies PlanParticipantSteerResult
        }
        const orchestratorId = orchestratorParticipantRoutingId(
          addressable.chatId
        )
        const currentSubagents = yield* addressable.run.subagents()
        if (
          request.routingId !== orchestratorId &&
          !currentSubagents.some(
            (participant) => participant.routingId === request.routingId
          )
        ) {
          return {
            status: "unavailable",
            detail:
              `Participant "${request.routingId}" is no longer active. ` +
              "Refresh the participant list before retrying or rerouting."
          } satisfies PlanParticipantSteerResult
        }
        return yield* addressable.run.replyGate.withPermits(1)(
          Effect.gen(function* () {
            const steered = yield* addressable.run.steer(request.text, [], true)
            if (steered.status !== "accepted") {
              return {
                status: "failed",
                detail:
                  `Participant "${request.routingId}" could not receive the message ` +
                  `(${steered.status}). Retry this message.`
              } satisfies PlanParticipantSteerResult
            }
            const waiter = steered.replyWaiter
            if (waiter === null) {
              return {
                status: "delivered",
                reply: null
              } satisfies PlanParticipantSteerResult
            }
            return yield* collectSteeredReply(waiter).pipe(
              Effect.map((reply) => ({
                status: "delivered" as const,
                reply
              })),
              Effect.ensuring(addressable.run.clearReplyWaiter(waiter))
            )
          })
        )
      })

    /** Thread a comment onto a plan step (persisted + streamed); doesn't resume the agent. */
    const commentPlanStep = (
      sessionId: string,
      planId: string,
      stepId: string,
      body: string,
      anchor?: { readonly quote: string; readonly prefix: string; readonly suffix: string }
    ) =>
      Effect.gen(function* () {
        const { run } = yield* pendingPlanRun(sessionId, planId)
        if (run === undefined) return
        const canonical = yield* canonicalPlan(sessionId, planId)
        const saved =
          canonical === null
            ? Option.none()
            : yield* PlanStore.addAnnotation(canonical.worktreePath, {
                planId,
                baseRevision: canonical.document.revision,
                // "" targets a section/global comment (no stage).
                stageId: stepId === "" ? null : stepId,
                body,
                author: "user",
                ...(anchor ? { anchor } : {})
              }).pipe(Effect.option)
        const persisted = Option.isSome(saved)
          ? planDocumentToPlan(saved.value).comments.at(-1)
          : undefined
        const cn = yield* nextId
        const now = yield* Effect.sync(() => new Date().toISOString())
        const comment: PlanComment =
          persisted ?? {
            id: `pc_${sessionId}_${cn}`,
            stepId,
            body,
            author: "user",
            createdAt: now,
            routed: false
          }
        yield* run.applyPlan(planId, (plan) => ({
          ...plan,
          comments: [...plan.comments, comment],
          steps: plan.steps.map((s) => (s.id === stepId ? { ...s, flagged: true } : s))
        }))
      })

    /** Route the open comments back to the agent as a revision and resume planning. */
    const revisePlan = (sessionId: string, planId: string) =>
      Effect.gen(function* () {
        const { run } = yield* pendingPlanRun(sessionId, planId)
        if (run === undefined) return
        const canonical = yield* canonicalPlan(sessionId, planId)
        const plan =
          canonical === null
            ? yield* run.readPlan(planId)
            : planDocumentToPlan(canonical.document)
        if (plan === null) return
        const open = plan.comments.filter((c) => !c.routed && c.author === "user")
        const routedIds = new Set(open.map((comment) => comment.id))
        const routedPlan =
          canonical === null
            ? null
            : resolveAnnotations(canonical.document.plan, routedIds)
        const feedback =
          canonical === null || routedPlan === null
            ? revisionText(plan, open)
            : [
                `Revise canonical plan revision ${canonical.document.revision}.`,
                "Treat the full plan below, including human edits and annotations, as the source of truth.",
                'Return a complete replacement as one ```json block with "mode":"submit".',
                "",
                "```json",
                JSON.stringify({ mode: "submit", plan: routedPlan }, null, 2),
                "```"
              ].join("\n")
        if (canonical !== null && routedPlan !== null) {
          yield* PlanStore.updateDocument(canonical.worktreePath, {
            planId,
            baseRevision: canonical.document.revision,
            plan: routedPlan,
            author: "user",
            // A status-only mutation (comments flushed to resolved). Skip the
            // user-edit reconcile: its `mergeAnnotation` keeps the PRIOR thread
            // authoritative and would discard the just-resolved status.
            semantic: false,
            status: "revising"
          }).pipe(Effect.ignore)
        }
        // Mark the plan under revision + flush its comments as routed.
        yield* run.applyPlan(planId, () => ({
          ...plan,
          status: "revising",
          comments: plan.comments.map((c) => (c.routed ? c : { ...c, routed: true }))
        }))
        yield* resolvePlan(sessionId, planId, PlanDecision.Revise({ feedback }))
      })

    /** Approve a plan: mark it approved, restore the exec mode, and start execution. */
    const approvePlan = (
      sessionId: string,
      planId: string,
      executionMode?: ExecutionMode,
      expectedRevision?: number
    ) =>
      Effect.gen(function* () {
        const { pending, run } = yield* pendingPlanRun(sessionId, planId)
        const canonical = yield* canonicalPlan(sessionId, planId)
        const session = yield* getSessionOrNull(sessionId)
        const producingChatId =
          pending?.chatId ??
          canonical?.document.producingChatId ??
          session?.activeChatId
        const orchestrating =
          producingChatId !== undefined &&
          session?.chats.find((chat) => chat.id === producingChatId)?.role ===
            "orchestrator"
        if (
          canonical !== null &&
          expectedRevision !== undefined &&
          canonical.document.revision !== expectedRevision
        ) {
          return approvalRefused(
            `Approval refused because canonical plan revision ${canonical.document.revision} replaced reviewed revision ${expectedRevision}. Review the latest revision and approve again.`,
            canonical.document.revision
          )
        }
        const exactPlan =
          canonical === null
            ? run === undefined
              ? null
              : yield* run.readPlan(planId)
            : planDocumentToPlan(canonical.document)
        if (exactPlan === null) {
          return approvalRefused(
            "Approval refused because the plan is no longer available.",
            canonical?.document.revision ?? 0
          )
        }
        if (orchestrating && canonical !== null) {
          const graph = buildPlanExecutionGraph(
            canonical.document.plan.stages,
            { requireAssignments: true }
          )
          if (!graph.valid) {
            return approvalRefused(
              [
                "Approval refused because the worker graph is invalid.",
                ...graph.diagnostics.map((diagnostic) => diagnostic.message)
              ].join(" "),
              canonical.document.revision
            )
          }
          const discovered = yield* DiscoveryService.list().pipe(
            Effect.orElseSucceed(() => [])
          )
          const catalog = planningOrchestrationRoutes(
            yield* modelsService.catalog(discovered)
          )
          const workspaceConfig = yield* ConfigService.get().pipe(
            Effect.orElseSucceed(() => null)
          )
          const workerRouting = resolveWorkerRoutingConfig(
            workspaceConfig?.workerRouting,
            catalog
          )
          if (workerRouting === null) {
            return approvalRefused(
              "Approval refused because no planning-capable worker route is available.",
              canonical.document.revision
            )
          }
          const unavailable = unavailableOrchestrationAssignment(
            canonical.document.plan.stages,
            catalog
          )
          if (unavailable?.assignment) {
            return approvalRefused(
              `Approval refused because stage "${unavailable.id}" is assigned to unavailable route "${unavailable.assignment.cli}/${unavailable.assignment.model}". Update its worker assignment from the live model catalogue and approve again.`,
              canonical.document.revision
            )
          }
          const routingMismatch = workerRoutingMismatch(
            canonical.document.plan.stages,
            workerRouting
          )
          if (routingMismatch?.assignment) {
            const expected = workerRouting[routingMismatch.complexity]
            return approvalRefused(
              `Approval refused because worker "${routingMismatch.id}" uses ${routingMismatch.assignment.cli}/${routingMismatch.assignment.model}, but the ${routingMismatch.complexity}-complexity router requires ${expected.cli}/${expected.model}. Revise the plan to apply the current worker routing settings.`,
              canonical.document.revision
            )
          }
        }
        if (canonical !== null) {
          const approval = yield* PlanStore.updateDocument(canonical.worktreePath, {
            planId,
            baseRevision: canonical.document.revision,
            plan: canonical.document.plan,
            author: "user",
            status: "executing"
          }).pipe(Effect.either)
          if (approval._tag === "Left") {
            return approvalRefused(
              approval.left.message,
              approval.left._tag === "PlanConflictError"
                ? approval.left.latestRevision
                : canonical.document.revision
            )
          }
        }
        if (run !== undefined) {
          yield* run.applyPlan(planId, () => ({ ...exactPlan, status: "approved" }))
          if (!orchestrating) yield* run.markPlanExecution(planId)
        }
        // Precedence lives in `exec-mode.ts`, where the reason `prior` must beat
        // `configDefault` is stated once — getting that pair the wrong way round
        // re-gates every command of the execution just approved.
        const mode = modeOnApproval({
          explicit: executionMode,
          prior: pending ? (yield* Ref.get(priorModes)).get(pending.chatId) : undefined,
          configDefault: pending ? (yield* Ref.get(execDefaults)).get(pending.chatId) : undefined
        })
        // Restore the exec mode live (canUseTool re-reads it) and persist it.
        if (pending) yield* setMode(sessionId, pending.chatId, mode)
        yield* resolvePlan(
          sessionId,
          planId,
          orchestrating
            ? PlanDecision.Delegate()
            : PlanDecision.Approve({
                mode,
                plan: { ...exactPlan, status: "approved" }
              })
        )
        return approvalAccepted
      })

    /**
     * The user's configured default execution mode for a session (`auto` /
     * `accept-edits` / `ask`), read from their CLI config. `AppPaths.root` is
     * `~/jingler`, so its parent is $HOME. Never fails.
     */
    const resolveExecMode = (sessionId: string): Effect.Effect<PermissionMode, never, PromptEnv> =>
      Effect.gen(function* () {
        const session = yield* getSessionOrNull(sessionId)
        const pathSvc = yield* Path.Path
        const appPaths = yield* AppPaths
        return yield* readDefaultMode(session?.cli ?? "claude", pathSvc.dirname(appPaths.root))
      })

    /** The plan with `planId` from a session's persisted transcript, or null. */
    const sessionPlan = (chatId: string, planId: string): Effect.Effect<Plan | null, never, PromptEnv> =>
      TranscriptStore.list(chatId).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<Message>),
        Effect.map((messages) => messages.reduce<Plan | null>((found, m) => findPlan(m, planId) ?? found, null))
      )

    /**
     * Approve a plan whose original run is gone (e.g. after an app restart, when
     * the plan is "stale"): there's no parked Deferred to resume, so re-drive
     * execution as a FRESH run. Set the session's default exec mode, then prompt
     * the agent with the plan embedded (the harness has no memory of the prior
     * planning conversation across a restart). Returns the run's event stream.
     */
    function resumePlan(
      sessionId: string,
      planId: string
    ): Stream.Stream<StreamEvent, never, PromptEnv>
    function resumePlan(
      sessionId: string,
      chatId: string,
      planId: string,
      expectedRevision?: number
    ): Stream.Stream<StreamEvent, never, PromptEnv>
    function resumePlan(
      sessionId: string,
      chatIdOrPlanId: string,
      maybePlanId?: string,
      expectedRevision?: number
    ): Stream.Stream<StreamEvent, never, PromptEnv> {
      const chatId = maybePlanId === undefined ? sessionId : chatIdOrPlanId
      const planId = maybePlanId ?? chatIdOrPlanId
      return Stream.unwrap(
        Effect.gen(function* () {
          const canonical = yield* canonicalPlan(sessionId, planId)
          if (
            canonical !== null &&
            expectedRevision !== undefined &&
            canonical.document.revision !== expectedRevision
          ) {
            return failedStream(
              `Plan execution refused because canonical revision ${canonical.document.revision} replaced reviewed revision ${expectedRevision}. Review the latest revision and approve again.`
            )
          }
          const plan =
            canonical === null
              ? yield* sessionPlan(chatId, planId)
              : planDocumentToPlan(canonical.document)
          if (plan === null) return Stream.empty
          if (canonical !== null) {
            const execution = yield* PlanStore.updateDocument(canonical.worktreePath, {
              planId,
              baseRevision: canonical.document.revision,
              plan: canonical.document.plan,
              author: "user",
              status: "executing"
            }).pipe(Effect.either)
            if (execution._tag === "Left") {
              return failedStream(
                `Plan execution could not start: ${execution.left.message}`
              )
            }
          }
          // Restore the mode the operator actually runs this session in. Plan mode
          // is never persisted, so `session.mode` is their real exec mode (e.g.
          // "auto"); fall back to the CLI-config default only if it's absent or a
          // legacy "plan". This keeps a stale-plan re-drive from re-gating.
          const persisted = (yield* getSessionOrNull(sessionId))?.chats.find(
            (chat) => chat.id === chatId
          )?.mode
          const restore =
            persisted && persisted !== "plan" ? persisted : yield* resolveExecMode(sessionId)
          yield* setMode(sessionId, chatId, restore)
          return prompt(sessionId, chatId, resumePlanPrompt(plan), [], undefined, plan.id)
        })
      )
    }

    /**
     * Halt a session's agent: settle whatever it's blocked on, then interrupt the
     * run itself.
     *
     * Both halves are load-bearing. Denying the pending gate/question/plan lets
     * the paused agent-side code resume and clean up its own bookkeeping (and
     * records the denial/rejection in the transcript, which the operator should
     * see). Interrupting then kills the run for real — including the common case
     * where the agent is mid-stream and blocked on nothing, where denial alone
     * would be a no-op and the agent would just carry on.
     *
     * Deny-then-interrupt, in that order: the reverse would strand the pending
     * entries, since the code that clears them sits after the `Deferred.await`
     * we'd have just killed.
     */
    const stop = (
      sessionId: string,
      requestedChatId?: string,
      awaitTeardown = false
    ) =>
      Effect.gen(function* () {
        const chatId = requestedChatId ?? sessionId
        // A stopped agent must not stay parked: gates deny, questions answer empty.
        yield* approvals.releaseChat(sessionId, chatId)
        // Plans reject, and the rejection is marked on the live turn first so the
        // transcript says what happened. The registry answers WHICH plans; marking
        // them stays here, where the run's accumulator lives.
        const run = (yield* Ref.get(active)).get(chatId)
        yield* Effect.forEach(
          yield* approvals.pendingPlanIds(sessionId, chatId),
          (planId) =>
            (run
              ? run.applyPlan(planId, (pl) => ({ ...pl, status: "rejected" }))
              : Effect.void
            ).pipe(
              Effect.zipRight(approvals.settlePlan(sessionId, planId, PlanDecision.Reject()))
            ),
          { discard: true }
        )
        // Now kill the run. `Fiber.interrupt` awaits the finalizers, so once this
        // returns the agent is genuinely stopped — not merely asked to stop.
        //
        // Read and interrupt under the session lock. `prompt` holds the SAME lock
        // across its whole setup — session load, the compaction swap, appending
        // the placeholder turns, and the fork+register — so the entry we read
        // here can only ever be a run that already existed when this stop began.
        // A turn the operator sends next queues behind us instead of being
        // silently killed by our interrupt.
        //
        // The token re-check is belt-and-braces for the one case the lock cannot
        // cover: a run that finishes and deregisters itself between our two
        // reads. Interrupting a fiber that already left the slot is harmless, but
        // comparing tokens says plainly which run we meant.
        //
        // The interrupt is time-capped. `Fiber.interrupt` waits for finalizers,
        // and the Claude adapter allows itself TEARDOWN_GRACE (15s) to unwind —
        // long enough that holding the lock for all of it would read as the app
        // ignoring the operator's next message. After the cap we stop WAITING;
        // the interrupt itself has already been delivered.
        const lock = yield* chatLock(chatId)
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const running = (yield* Ref.get(fibers)).get(chatId)
            if (running === undefined) return
            const current = (yield* Ref.get(fibers)).get(chatId)
            if (current?.token !== running.token) return
            const interrupt = Fiber.interrupt(running.fiber).pipe(Effect.asVoid)
            yield* (
              awaitTeardown
                ? interrupt
                : interrupt.pipe(
                    Effect.timeout(INTERRUPT_GRACE),
                    Effect.ignore
                  )
            )
          })
        )
        // Kill any digest being prepared for this session too. It runs on a
        // DAEMON fiber, so interrupting the run leaves it alive — an operator who
        // stopped a session would otherwise keep paying for a summary of it, with
        // nothing on screen to say why.
        yield* ContextManager.cancel(chatId).pipe(Effect.ignore)
      })

    /**
     * Everything a turn needs before it has a fiber: session load, CLI
     * discovery, the compaction swap, the placeholder turns, and the fork.
     *
     * Split out from `prompt` purely so the whole region can run under the
     * session lock. It completes the moment the mailbox stream is handed back,
     * so the permit covers setup only — never the life of the run.
     *
     * The placeholder append has to be inside the lock, not just the fork:
     * `TranscriptStore.patchLast` patches whatever message is last, so a stop
     * still unwinding while the next turn appended its placeholder would write
     * its "Stopped." note onto the NEW turn.
     */
    const promptSetup = (
      sessionId: string,
      chatId: string,
      text: string,
      images: ReadonlyArray<Attachment>,
      reasoning: ReasoningSetting | null | undefined,
      planExecutionId?: string,
      externalInstruction?: ExternalInstructionIdentity,
      displayText?: string
    ) =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const adapter = yield* CliAdapter
          const session: Session | null = yield* getSessionOrNull(sessionId)
          const chat =
            session?.chats.find((candidate) => candidate.id === chatId) ??
            (chatId === sessionId
              ? session?.chats.find(
                  (candidate) => candidate.id === session.activeChatId
                ) ?? null
              : null)
          if (session === null || chat === null) {
            return yield* Effect.fail(
              new CliExecError({
                kind: "chat",
                message: "The selected chat no longer exists."
              })
            )
          }
          yield* TranscriptStore.adoptLegacy(sessionId, chatId)

          const sessionMode =
            (yield* Ref.get(modes)).get(chatId) ?? chat.mode ?? defaultModeFor(session.cli)
          const allow = new Set<string>([
            ...(yield* approvals.allowlistFor(chatId)),
            ...(chat.allowlist ?? [])
          ])
          const sessionCli = session.cli
          const workspaceConfig = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          // Read per turn: each orchestrator chat can independently opt out of
          // the worker flow. The workspace setting remains the fallback for
          // chats written before the per-chat field existed.
          const orchestratorEnabled =
            chat.orchestratorEnabled ??
            workspaceConfig?.orchestratorEnabled ??
            ORCHESTRATOR_ENABLED_DEFAULT
          const orchestrating = chat.role === "orchestrator" && orchestratorEnabled
          const discoveredClis = yield* DiscoveryService.list().pipe(
            Effect.orElseSucceed(() => [])
          )
          // Read once per turn: plan mode's commands run unattended unless the
          // operator switched that off in Settings.
          const planAutoRun = workspaceConfig?.planAutoRun ?? PLAN_AUTO_RUN_DEFAULT
          // Read per turn, not per session: flipping ADHD mode in Settings takes
          // effect on the very next message of an already-running session.
          const adhdMode = workspaceConfig?.adhdMode ?? ADHD_MODE_DEFAULT
          const cli = sessionCli
          const orchestrationRoutes = planningOrchestrationRoutes(
            yield* modelsService.catalog(discoveredClis)
          )
            .map((provider) => ({
              cli: provider.cli,
              models: provider.models
            }))
          const workerRouting = resolveWorkerRoutingConfig(
            workspaceConfig?.workerRouting,
            orchestrationRoutes
          )
          // Cache the user's configured default exec mode so approving a plan can
          // restore it.
          const execDefault = yield* resolveExecMode(sessionId)
          yield* Ref.update(execDefaults, (m) => new Map(m).set(chatId, execDefault))
          // Resolve the harness binary; null → the dispatcher uses the scripted
          // fallback (also the path when the CLI isn't installed).
          const binPath = discoveredClis.find((c) => c.kind === cli)?.binPath ?? null
          // The agent always runs in the session's recorded working checkout.
          //
          // This comment used to claim an empty value "would fail loudly on a
          // missing worktree". It did the exact opposite: the adapters mapped
          // `"" || undefined` to *no* cwd, so the harness inherited the Electron
          // main process's working directory — in development, whichever worktree
          // `pnpm dev` was launched from. An agent for repo A would then read and
          // edit repo B, most likely Jingler's own source. The adapters now call
          // `requireWorktree`, which throws rather than inheriting.
          // Recover the worktree path if `~/jingler` or the repo directory has
          // been renamed since this session was created.
          //
          // `worktreePath` is stored ABSOLUTE and nothing rewrites it — this
          // app's own rename moved the home directory and shipped no migration
          // — so the stored value can name a directory that is not there while
          // the worktree sits perfectly intact one name over. Healing it also
          // moves the agent CLI's transcripts, which are filed under a slug of
          // the working directory and are otherwise lost to `--resume`.
          //
          // Costs one `stat` on the overwhelmingly common healthy path.
          const storedWorktree = session?.worktreePath ?? ""
          const healPaths = yield* AppPaths
          const worktreePath = session
            ? workspaceModeOf(session) === "direct"
              ? storedWorktree
              : yield* healedWorktreePath(
                  storedWorktree,
                  session.repo,
                  healPaths.worktreesDir
                )
            : storedWorktree
          if (worktreePath !== storedWorktree) {
            yield* SessionStore.setWorktreePath(sessionId, worktreePath).pipe(
              Effect.ignore
            )
          }
          // Re-point the worktree at its repo if the repo directory has moved
          // since the worktree was forked. A worktree's link to its repo is an
          // ABSOLUTE path, so renaming the repo leaves the directory intact but
          // every git command inside it failing — the agent would run, edit
          // files, and only fail at diff/commit time with "not a git
          // repository". Memoised per worktree, so this is one `rev-parse` on
          // the first turn and nothing after.
          if (
            worktreePath.length > 0 &&
            session?.repoPath &&
            workspaceModeOf(session) === "worktree"
          ) {
            yield* ensureWorktreeLinked(session.repoPath, worktreePath)
          }
          // A direct session shares the repository's primary checkout with the
          // developer. Refuse every turn after that checkout moves: continuing
          // would run the agent on a branch different from the one recorded in
          // the session, while plans and review state still name the old branch.
          if (workspaceModeOf(session) === "direct") {
            const liveBranch = yield* branchAt(worktreePath)
            if (liveBranch !== session.branch) {
              const actual =
                liveBranch === null ? "detached HEAD" : `branch "${liveBranch}"`
              return yield* Effect.fail(
                new CliExecError({
                  kind: session.cli,
                  message:
                    `This direct session is pinned to branch "${session.branch}", but ` +
                    `the repository checkout is now on ${actual}. Switch the repository ` +
                    `back to "${session.branch}" before continuing.`
                })
              )
            }
          }
          // Saved plans for this worktree, so a "implement/continue the plan" turn
          // can be pointed at the plan file on disk (best-effort — never blocks).
          const savedPlans =
            worktreePath.length > 0
              ? yield* PlanStore.list(worktreePath).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              : []
          // Whether this orchestrator already has an approved canonical plan.
          // "Approved" is every post-gate status — once the operator approves,
          // the plan moves through executing → needs-verification → done and
          // never returns to the approval gate. Read from the canonical document,
          // the single source of truth (a non-orchestrator turn skips the read).
          const canonicalPlan =
            orchestrating && worktreePath.length > 0
              ? yield* PlanStore.readDocument(worktreePath, sessionId, chatId).pipe(
                  Effect.orElseSucceed(() => null)
                )
              : null
          const planApproved =
            canonicalPlan !== null &&
            (canonicalPlan.status === "approved" ||
              canonicalPlan.status === "executing" ||
              canonicalPlan.status === "needs-verification" ||
              canonicalPlan.status === "done")
          // Orchestration is a coordination role, not a permission escalation.
          // The orchestrator can still complete bounded work directly, but only
          // with the edit/command authority the operator selected for this chat.
          // Plan approval restores an execution mode through `setMode`, so this
          // does not force later orchestrator turns back through another gate.
          const mode: PermissionMode = sessionMode
          yield* ContextManager.bindContext(chatId, sessionId)
          /**
           * Consume a ready digest, if the context manager has one waiting.
           *
           * This is the entire swap. Normally the digest was prepared while the
           * user read the last answer, so applying it only changes the spec
           * below. After a hard overflow, however, the failed turn starts the
           * digest; an immediate retry waits here rather than resuming the same
           * full thread. Sub-agents never reach this top-level path.
           */
          yield* ContextManager.prepareUnknownCodexResume(chatId)
          const applied = yield* ContextManager.applyWhenReady(chatId)
          const digest = applied?.digest ?? null
          // The WORKING SET at the moment of the swap, straight from the manager.
          //
          // Deliberately NOT `session.tokens`: that is the session's lifetime
          // total (see `Session.contextTokens` in domain.ts) and only ever grows,
          // which is how the marker came to read "Context compacted from
          // 49894.2k" — ~49.9M lifetime tokens rendered as a working set. The
          // persisted `contextTokens` is the fallback for a session whose live
          // reading has not arrived yet; 0 hides the clause entirely.
          const compactedFrom =
            applied === null
              ? 0
              : applied.tokensBefore > 0
                ? applied.tokensBefore
                : session?.contextTokens ?? 0
          // Everything that landed after the digest was built is replayed
          // verbatim, so preparing in the background never races the user.
          const tail =
            digest === null
              ? []
              : tailAfter(
                  yield* TranscriptStore.list(chatId).pipe(Effect.orElseSucceed(() => [])),
                  digest.throughMessageId
                )

          // Renamed from `planNote` when the plan-mode protocol note arrived: two
          // different plan-related prefixes with one name is a trap.
          const planPointer = savedPlans.length > 0 ? planPointerNote(worktreePath, savedPlans) : null
          const primer = digest === null ? null : renderPrimer(digest, tail)
          // ADHD mode rides in the same per-turn prefix as the primer and plan
          // pointer so a Settings change applies immediately. Its own scope makes
          // the format dormant during work and active only for the final summary.
          // The orchestrator gets its own persona, not the ADHD note: one
          // string for every harness (so it reads the same on Opus and Codex)
          // and always on, since being an orchestrator is a role, not an
          // operator-toggled setting. Plain chats keep the scoped ADHD note.
          const adhd = orchestrating
            ? orchestratorNote()
            : adhdMode
              ? adhdNote(cli)
              : null
          // Not optional, and not a setting: an agent that asks in prose is an
          // agent whose question never reaches the operator. Claude has the
          // `AskUserQuestion` tool the adapter intercepts, Codex has the fenced
          // block the adapter parses — but nothing tells either of them to
          // prefer it, so both default to asking in chat text that renders as
          // an unanswerable paragraph. Rides the same per-turn prefix as ADHD
          // mode, for the same reason: no system-prompt hook is shared by every
          // harness, and this has to survive a mid-session harness switch.
          const ask = questionNote(cli)
          // How this harness submits a plan. Null for Claude — the adapter passes
          // `planModeInstructions` as a real SDK option there, and saying it twice
          // would compete with the `ExitPlanMode` tool the harness is steered
          // toward. Everything else is told to end its reply with the block.
          const planProtocol =
            mode === "plan"
              ? planNote(
                  cli,
                  orchestrating ? orchestrationRoutes : undefined,
                  orchestrating ? workerRouting ?? undefined : undefined
                )
              : null
          const priorMessages = yield* TranscriptStore.list(chatId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const operatorText = displayText ?? text
          const promptText = orchestrating
            ? orchestratorTurnPrompt(planApproved, text)
            : text
          const providerReasoning =
            cli === "claude" || cli === "codex" || cli === "opencode"
              ? session.reasoning?.[cli]
              : undefined
          const resolvedReasoning =
            reasoning === undefined ? providerReasoning : reasoning

          // Resolve every remote MCP source once, here, where the full service
          // context is available — adapters run in `R = never` async code and
          // cannot reach services. Best-effort: a configured connector read
          // failure yields null rather than failing the whole turn.
          // Accessor (not a captured instance) so this stays in the METHOD's
          // requirement channel (`PromptEnv`) rather than becoming a build-time
          // dependency of `AgentRunner.Default` — the latter is a singleton whose
          // construction must stay `R = never` for the layer graph and tests.
          const openConnectorServer = yield* OpenConnectorService.injection(cli).pipe(
            Effect.orElseSucceed(() => null)
          )

          // Browser control is exclusive within one repository session but
          // independent sessions receive isolated native views and may QA in
          // parallel. The scoped lease revokes its bearer when the run ends.
          const browserAttachment = yield* (
            yield* BrowserControlMcpService
          ).acquire(sessionId, `${sessionId}:${chatId}`)
          // Jingler owns this pre-turn boundary, so recall is deterministic for
          // every harness (including Codex, which has no context-injecting hook).
          // Pass only the raw operator text: orchestration/persona notes are not
          // useful search terms and would dilute a narrow memory query.
          const memoryAttachment = yield* memoryService.attachment(
            cli,
            operatorText,
            `${sessionId}:${chatId}`
          )
          const remoteMcpServers = composeRemoteMcpServers(
            memoryAttachment?.server ?? null,
            remoteMcpServer(openConnectorServer),
            browserAttachment
          )

          const spec: SessionSpec = {
            cli,
            repo: session?.repo ?? "",
            branch: session?.branch ?? "",
            cwd: worktreePath,
            // A slash command is only expanded by the harness when it is the FIRST
            // thing in the message. Prefixing a compaction primer or a plan pointer
            // turned `/babysit-pr …` into prose, and the turn came back instantly
            // with nothing to say — the empty "CLAUDE" block. When the operator
            // opens with a command, the context rides along AFTER it instead.
            prompt: composeTurnPrompt(
              promptText,
              {
                primer,
                planPointer,
                adhd,
                memory: memoryAttachment?.instructions ?? null,
                ask,
                planProtocol
              },
              { leadWithText: leadsWithCommand(cli, promptText) }
            ),
            images,
            binPath,
            mode,
            model: chat.model ?? defaultModel(cli),
            ...(mode === "plan"
              ? { planTemplate: workspaceConfig?.planTemplate?.source ?? "" }
              : {}),
            ...(orchestrating
              ? { orchestrationRoutes, orchestrationPlanApproved: planApproved }
              : {}),
            ...(orchestrating && workerRouting !== null
              ? { workerRouting }
              : {}),
            ...(resolvedReasoning === null
              ? {}
              : {
                  ...(resolvedReasoning?.enabled === undefined
                    ? {}
                    : { thinkingEnabled: resolvedReasoning.enabled }),
                  ...(resolvedReasoning?.effort === undefined
                    ? {}
                    : { reasoningEffort: resolvedReasoning.effort })
                }),
            // The persisted harness session id, so the adapter resumes the full
            // conversation even after a restart cleared its in-memory resume map.
            //
            // On a compaction this is dropped: the whole point is to begin a NEW
            // harness conversation seeded with the summary. `fresh` is required
            // alongside it because the adapter prefers its in-memory resume map
            // over the spec, so a null id alone would silently resume anyway.
            resumeId: digest === null ? chat.resumeId ?? null : null,
            ...(digest === null ? {} : { fresh: true }),
            // `mode: plan` is the transient read-only boundary. Do not also set
            // the permanent `readOnly` role flag: Codex resumes this SAME spec
            // after approval, and a permanent flag would keep its sandbox
            // read-only instead of restoring the orchestrator's Auto policy.
            // Each adapter enforces plan mode in its own native vocabulary.
            remoteMcpServers
          }

          // Clear the PERSISTED id too, so a crash between here and the harness
          // reporting its new id can't leave the session pointing at a thread
          // whose context we have already decided to abandon.
          if (digest !== null) {
            yield* SessionStore.clearResumeId(sessionId, chatId).pipe(Effect.ignore)
          }

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            | TranscriptStore
            | SessionStore
            | PlanStore
            | BackgroundTaskStore
            // `emit` hands every context reading to the manager, which may fork a
            // digest run — so the manager's own dependencies (the adapter it
            // summarises through, the config holding the budget, the discovery
            // that finds the binary) have to be captured here too, or `emit`
            // stops being `R = never` and the whole fold fails to type.
            | ContextManager
            | ConfigService
            | CliAdapter
            | DiscoveryService
            | CommandExecutor.CommandExecutor
            | FileSystem.FileSystem
            | Path.Path
            | AppPaths
            | SecretStore
          >()

          const now = yield* Effect.sync(() => new Date().toISOString())
          // The id counter is in-memory and resets when the app restarts, but the
          // transcript persists — so seed it past any id already recorded for this
          // session, otherwise a run after a restart re-emits colliding ids
          // (`u_<sid>_1`, `a_<sid>_2`, …) and the virtualized transcript stacks
          // rows keyed by those ids. Deterministic: empty transcript → starts at 1.
          const priorMax = priorMessages.reduce((max, m) => {
              const n = Number(m.id.split("_").pop())
              return Number.isFinite(n) && n > max ? n : max
            }, 0)
          yield* Ref.update(counter, (c) => Math.max(c, priorMax))
          const un = yield* nextId
          const an = yield* nextId
          const user = userMessage(
            `u_${chatId}_${un}`,
            operatorText,
            now,
            images,
            externalInstruction
          )
          const assistant = assistantMessage(`a_${chatId}_${an}`, now)
          const appended = yield* TranscriptStore.appendTurn(
            chatId,
            user,
            assistant,
            externalInstruction
          )
          if (!appended && externalInstruction !== undefined) {
            return Stream.fromIterable<StreamEvent>([{
              _tag: "ExternalInstructionAccepted",
              identity: externalInstruction,
              duplicate: true
            }])
          }
          const acc = yield* Ref.make(assistant)
          // The exact ```json blocks `saveDraftPlan` captured this turn, scrubbed
          // from the reply on settle (the plan lives in Plan Review, not the chat).
          const savedDraftBlocks = yield* Ref.make<ReadonlyArray<string>>([])
          const turnSteer = yield* Ref.make<SteerTurn | null>(null)
          const steeredReply = yield* Ref.make<RunReplyWaiter | null>(null)
          const replyGate = yield* Effect.makeSemaphore(1)
          const activeSubagents = yield* Ref.make(
            new Map<string, PlanParticipant>()
          )
          const turnMutation = yield* Effect.makeSemaphore(1)
          const executingPlanId = yield* Ref.make<string | null>(planExecutionId ?? null)

          const out = yield* Mailbox.make<StreamEvent>()
          if (externalInstruction !== undefined) {
            yield* out.offer({
              _tag: "ExternalInstructionAccepted",
              identity: externalInstruction,
              duplicate: false
            })
          }

          /**
           * ── Instrumentation: turns that end without settling ────────────────
           *
           * A turn's `streaming` flag is cleared by exactly two events, `Done`
           * and `Failed` (see `applyEvent` in core/conversation.ts). A run that
           * ends without emitting either leaves the turn spinning in the live UI
           * forever — the "turn died and never responded" report. It reads as
           * self-healing because `settleStreaming()` wipes stale flags whenever
           * the transcript is re-read, so a reload hides the evidence.
           *
           * Measured at 142 of 729 persisted assistant messages (~19.5%), so this
           * is common, not exotic — but which path skips both events is still
           * unknown, and interrupts are NOT uniformly to blame (one interrupted
           * turn settled with the stop note while another, same session, did not).
           *
           * So: record the shape of every unsettled exit, and let the next
           * occurrence say what it was. Purely observational — it changes no
           * behaviour and cannot fail a run (`Effect.ignore` at the call site).
           */
          const sawTerminal = yield* Ref.make(false)
          /**
           * Resolved when the turn reaches its terminal event.
           *
           * A Deferred beside the Ref rather than polling it: the drain supervisor
           * below has to WAIT for the turn to settle before it starts asking about
           * background tasks, and a settled turn is a one-way edge.
           */
          const turnSettled = yield* Deferred.make<void>()
          const eventCount = yield* Ref.make(0)
          const lastEvent = yield* Ref.make<string>("<none>")
          const wasInterrupted = yield* Ref.make(false)
          const memoryRetrieval = yield* Ref.make(
            memoryAttachment?.retrieval ?? EMPTY_MEMORY_RETRIEVAL_SUMMARY
          )

          // toolUseId → the file an edit tool is writing, remembered at ToolStart so
          // its ToolEnd can mark the matching plan step done (see markPlanProgress).
          const editTargets = yield* Ref.make(new Map<string, string>())

          // The whole transcript, best-effort — the plan under execution usually
          // lives in an EARLIER message than this turn's accumulator.
          const allMessages: Effect.Effect<ReadonlyArray<Message>> = TranscriptStore.list(chatId).pipe(
            Effect.provide(env),
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )

          // Find a plan and the message holding it. A plan part stays in the
          // message of the turn it was PROPOSED in, while execution runs on over
          // later turns — each with its own accumulator. So looking only at `acc`
          // finds the plan on the proposing turn and never again. Accumulator
          // first (it's the freshest copy of this turn's message), then the
          // persisted transcript.
          const locatePlan = (
            planId: string
          ): Effect.Effect<{ readonly plan: Plan; readonly messageId: string } | null> =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(acc)
              const inAcc = findPlan(cur, planId)
              if (inAcc !== null) return { plan: inAcc, messageId: cur.id }
              const msgs = yield* allMessages
              for (let i = msgs.length - 1; i >= 0; i--) {
                const found = findPlan(msgs[i]!, planId)
                if (found !== null) return { plan: found, messageId: msgs[i]!.id }
              }
              return null
            })

          // Read the current plan, wherever in the transcript it lives.
          const readPlan = (planId: string): Effect.Effect<Plan | null> =>
            Effect.map(locatePlan(planId), (located) => located?.plan ?? null)

          // Replace a plan part in place: update the accumulator + persisted
          // transcript, and push a `PlanUpdated` so an attached renderer syncs.
          // Addresses the plan's OWN message — `patchLast` would hit this turn's
          // message, which for a plan proposed on an earlier turn holds no plan.
          const applyPlan = (planId: string, f: (plan: Plan) => Plan): Effect.Effect<void> =>
            Effect.gen(function* () {
              const located = yield* locatePlan(planId)
              if (located === null) return
              const nextPlan = f(located.plan)
              const patch = (m: Message): Message => ({
                ...m,
                parts: m.parts.map((p) =>
                  p._tag === "Plan" && p.plan.id === planId ? { _tag: "Plan", plan: nextPlan } : p
                )
              })
              const cur = yield* Ref.get(acc)
              if (located.messageId === cur.id) {
                const next = patch(cur)
                yield* Ref.set(acc, next)
                yield* TranscriptStore.patchLast(chatId, () => next).pipe(Effect.ignore)
              } else {
                // The plan is behind us: patch its message directly and leave the
                // accumulator alone (it holds a different, later message).
                yield* TranscriptStore.patchById(chatId, located.messageId, patch).pipe(Effect.ignore)
              }
              // The transcript is a projection. Canonical HTML writes happen
              // through revision-aware PlanStore operations at the intent that
              // caused them; deriving HTML back from this legacy card would lose
              // operator-authored PRD sections.
              yield* out.offer({ _tag: "PlanUpdated", plan: nextPlan })
            }).pipe(Effect.provide(env), Effect.asVoid)

          // When an edit lands during execution of an approved plan, mark the plan
          // step whose proposed files include the edited path as "done" — tying live
          // progress back to the plan. Path matching is suffix-based so an absolute
          // worktree path matches a step's repo-relative file.
          const markPlanProgress = (toolId: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const target = (yield* Ref.get(editTargets)).get(toolId)
              if (target === undefined) return
              // Accumulator first (the plan was proposed this turn), else the
              // transcript (it was proposed earlier and execution has moved on).
              const cur = yield* Ref.get(acc)
              const inAcc = cur.parts.find((p) => p._tag === "Plan" && p.plan.status === "approved")
              const executing =
                inAcc !== undefined && inAcc._tag === "Plan"
                  ? { plan: inAcc.plan, messageId: cur.id }
                  : findApprovedPlan(yield* allMessages)
              if (executing === null) return
              const t = normalizePath(target)
              const step = executing.plan.steps.find(
                (s) => s.status !== "done" && s.files.some((f) => samePath(t, normalizePath(f.path)))
              )
              if (step === undefined) return
              yield* applyPlan(executing.plan.id, (pl) => ({
                ...pl,
                steps: pl.steps.map((s) => (s.id === step.id ? { ...s, status: "done" as const } : s))
              }))
            })

          const recordPlanEvidence = (text: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (worktreePath.length === 0) return
              const activePlanId = yield* Ref.get(executingPlanId)
              if (activePlanId === null) return
              const markers = planEvidenceFromText(text)
              if (markers.length === 0) return
              const initial = yield* PlanStore.readDocument(worktreePath)
              if (
                initial === null ||
                initial.id !== activePlanId ||
                !["approved", "executing", "needs-verification"].includes(initial.status)
              ) return
              let document: NonNullable<typeof initial> = initial
              for (const marker of markers) {
                if (
                  !document.plan.stages.some((stage) =>
                    stage.acceptance.some((criterion) => criterion.id === marker.criterionId)
                  )
                ) continue
                const updated = yield* PlanStore.setCriterionStatus(worktreePath, {
                  planId: document.id,
                  baseRevision: document.revision,
                  criterionId: marker.criterionId,
                  status: marker.status,
                  evidence: marker.evidence,
                  author: "agent"
                }).pipe(Effect.either)
                if (updated._tag === "Right") document = updated.right
              }
              const complete = document.plan.stages.every((stage) =>
                stage.acceptance.every(
                  (criterion) =>
                    criterion.status === "passed" || criterion.status === "waived"
                )
              )
              if (complete) {
                yield* PlanStore.updateDocument(worktreePath, {
                  planId: document.id,
                  baseRevision: document.revision,
                  plan: document.plan,
                  author: "agent",
                  status: "done"
                }).pipe(Effect.ignore)
              }
            }).pipe(Effect.provide(env), Effect.ignore)

          const finalizePlanVerification = (): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (worktreePath.length === 0) return
              const activePlanId = yield* Ref.get(executingPlanId)
              if (activePlanId === null) return
              const document = yield* PlanStore.readDocument(worktreePath)
              if (
                document === null ||
                document.id !== activePlanId ||
                document.status !== "executing"
              ) return
              const complete = document.plan.stages.every((stage) =>
                stage.acceptance.every(
                  (criterion) =>
                    criterion.status === "passed" || criterion.status === "waived"
                )
              )
              yield* PlanStore.updateDocument(worktreePath, {
                planId: document.id,
                baseRevision: document.revision,
                plan: document.plan,
                author: "agent",
                status: complete ? "done" : "needs-verification"
              }).pipe(Effect.ignore)
            }).pipe(Effect.provide(env), Effect.ignore)

          // Approved-plan replies have four explicit outcomes. Applied updates
          // emit PlanUpdated and requeue changed work; not-present is an ordinary
          // direct/coordination reply; invalid and conflict surface diagnostics
          // live and retain them in the transcript for the next repair turn.
          const applyOrchestratorAmendment = (
            text: string
          ): Effect.Effect<OrchestratorAmendmentOutcome> =>
            Effect.gen(function* () {
              const knownRevision = canonicalPlan?.revision ?? null
              if (!orchestrating || !planApproved || worktreePath.length === 0) {
                return amendmentNotPresent(knownRevision)
              }
              const amendment = parseOrchestratorAmendment(text)
              if (amendment === null) {
                return amendmentNotPresent(knownRevision)
              }
              const current = yield* PlanStore.readDocument(worktreePath, sessionId, chatId)
              if (
                current === null ||
                current.producingChatId !== chatId ||
                !["approved", "executing", "needs-verification", "done"].includes(current.status)
              ) {
                return amendmentFailure(
                  "conflict",
                  current?.revision ?? knownRevision,
                  [
                    "The canonical approved plan is no longer available to this orchestrator turn."
                  ]
                )
              }
              if (workerRouting === null) {
                return amendmentFailure("invalid", current.revision, [
                  "No valid worker routing configuration is available."
                ])
              }
              const compiled = compileOrchestrationPlan(
                amendment,
                workerRouting,
                { previousStages: current.plan.stages }
              )
              if (!compiled.valid) {
                return amendmentFailure(
                  "invalid",
                  current.revision,
                  compiled.diagnostics.map(
                    (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`
                  )
                )
              }
              const updated = yield* PlanStore.updateDocument(worktreePath, {
                planId: current.id,
                baseRevision: current.revision,
                plan: compiled.plan,
                author: "agent",
                reconcile: true,
                status: "executing"
              }).pipe(Effect.either)
              if (updated._tag === "Left") {
                return updated.left._tag === "PlanConflictError"
                  ? amendmentFailure(
                      "conflict",
                      updated.left.latestRevision,
                      [updated.left.message]
                    )
                  : amendmentFailure("invalid", current.revision, [
                      updated.left.message
                    ])
              }
              yield* out.offer({
                _tag: "PlanUpdated",
                plan: planDocumentToPlan(updated.right)
              })
              return amendmentApplied(updated.right.revision)
            }).pipe(Effect.provide(env))

          // Fold each event into the assistant message + persist, then surface it.
          // Native steering enters from an RPC fiber, so serialize it with the
          // adapter's event producer. A turn/completed notification arriving in
          // the same stdout chunk as the steer response must land on the NEW
          // assistant placeholder, never race it and leave that placeholder open.
          const emit = (event: StreamEvent): Effect.Effect<void> =>
            turnMutation.withPermits(1)(Effect.gen(function* () {
              // Codex can surface one app-server failure as both `turn.failed`
              // and `error`. The first terminal owns the turn; folding the
              // second printed the same context-overflow message twice.
              if (isTerminal(event)) {
                if (yield* Ref.get(sawTerminal)) return
                yield* Ref.set(sawTerminal, true)
                yield* Deferred.succeed(turnSettled, void 0)
              }
              // Tracked before the early returns below, so background-task and
              // sub-agent events still count toward "what did this run actually
              // emit" — a run that produced only sub-agent chatter and then
              // vanished is a different failure from one that emitted nothing.
              yield* Ref.update(eventCount, (n) => n + 1)
              yield* Ref.set(lastEvent, event._tag)
              if (event._tag === "ToolStart") {
                yield* Ref.update(memoryRetrieval, (summary) =>
                  recordMemoryRetrieval(summary, event.name)
                )
              }
              if (event._tag === "SubagentStarted") {
                const ownerRoutingId = orchestratorParticipantRoutingId(chatId)
                const routingId = subagentParticipantRoutingId(
                  ownerRoutingId,
                  event.id
                )
                yield* Ref.update(activeSubagents, (subagents) =>
                  new Map(subagents).set(routingId, {
                    routingId,
                    displayName: event.name,
                    role: "subagent",
                    lifecycle: "running",
                    ownerRoutingId
                  })
                )
              }
              if (event._tag === "SubagentEnded") {
                const routingId = subagentParticipantRoutingId(
                  orchestratorParticipantRoutingId(chatId),
                  event.id
                )
                yield* Ref.update(activeSubagents, (subagents) => {
                  const next = new Map(subagents)
                  next.delete(routingId)
                  return next
                })
              }
              if (event._tag === "Assistant") {
                const waiter = yield* Ref.get(steeredReply)
                if (waiter !== null) {
                  yield* appendSteeredReply(waiter, event.text)
                }
              }
              // Where this event belongs, and why, lives in `turn-events.ts`.
              const route = routeOf(event)
              if (route === "background-task") {
                // Into the session's task registry — it outlives this turn — and on
                // to the renderer so the dock updates live.
                yield* BackgroundTaskStore.ingest(sessionId, chatId, event).pipe(Effect.provide(env), Effect.ignore)
                yield* out.offer(event)
                return
              }
              if (route === "subagent" || route === "stream-only") {
                // Renderer only. Neither belongs on the persisted main turn.
                yield* out.offer(event)
                return
              }
              // A finished turn reports what it used. Accrued here rather than
              // in the adapters so every harness lands in one place — and so a
              // harness that reports nothing simply adds zero instead of needing
              // its own bookkeeping.
              if (event._tag === "Done") {
                yield* SessionStore.addUsage(sessionId, {
                  costUsd: event.costUsd,
                  tokens: event.tokens
                }).pipe(Effect.provide(env), Effect.ignore)
              }
              let next = applyStreamEvent(yield* Ref.get(acc), event)
              let liveAmendmentFeedback: string | null = null
              if (event._tag === "Done") {
                const settledText = next.parts
                  .filter((part) => part._tag === "Text")
                  .map((part) => part.text)
                  .join("\n")
                yield* recordPlanEvidence(settledText)
                // An approved-plan orchestrator turn may carry a plan amendment.
                // Apply it (reconciled, no re-approval) and, if it landed, scrub
                // the raw ````html block from the reply the operator reads.
                const amendmentOutcome = yield* applyOrchestratorAmendment(
                  settledText
                )
                if (amendmentOutcome.status === "applied") {
                  next = {
                    ...next,
                    parts: next.parts.flatMap((part): ReadonlyArray<ContentPart> => {
                      if (part._tag !== "Text") return [part]
                      const stripped = stripOrchestratorAmendment(part.text)
                      return stripped.length === 0 ? [] : [{ ...part, text: stripped }]
                    })
                  }
                } else {
                  const feedback = orchestratorAmendmentOutcomeText(
                    amendmentOutcome
                  )
                  if (feedback !== null) {
                    liveAmendmentFeedback = feedback
                    const feedbackPart: ContentPart = {
                      _tag: "Text",
                      text: feedback
                    }
                    next = {
                      ...next,
                      parts: [...next.parts, feedbackPart]
                    }
                  }
                }
              }
              if (
                (event._tag === "Done" || event._tag === "Failed") &&
                (yield* Ref.get(executingPlanId)) !== null
              ) {
                next = {
                  ...next,
                  parts: next.parts.flatMap((part): ReadonlyArray<ContentPart> => {
                    if (part._tag !== "Text") return [part]
                    const text = stripPlanResultProtocol(part.text)
                    return text.length === 0 ? [] : [{ ...part, text }]
                  })
                }
              }
              // A "draft" emission mirrors into Plan Review but leaves its raw
              // ```json block in the reply (submit blocks are scrubbed at promotion).
              // On settle, remove exactly the blocks `saveDraftPlan` captured this
              // turn — never a plan the agent merely quoted — so the transcript
              // reads as prose, not a wall of JSON.
              if (event._tag === "Done") {
                const draftBlocks = yield* Ref.get(savedDraftBlocks)
                if (draftBlocks.length > 0) {
                  next = {
                    ...next,
                    parts: next.parts.flatMap((part): ReadonlyArray<ContentPart> => {
                      if (part._tag !== "Text") return [part]
                      const text = draftBlocks.reduce(
                        (acc, block) => stripPlanJsonBlock(acc, block),
                        part.text
                      )
                      return text.length === 0 ? [] : [{ ...part, text }]
                    })
                  }
                }
              }
              yield* Ref.set(acc, next)
              yield* TranscriptStore.patchLast(chatId, () => next).pipe(Effect.ignore)
              // Persist the harness's actual model (reported on init) so the chip
              // reflects reality even when the session hadn't pinned one.
              if (event._tag === "Started" && event.model) {
                yield* SessionStore.setModel(sessionId, chatId, event.model).pipe(Effect.ignore)
              }
              // Persist the harness session id (carried on Started) so the NEXT
              // prompt resumes this conversation — even after an app restart wiped
              // the adapter's in-memory resume map. `event.sessionId` is the
              // harness's own id, not our `sessionId` (the Jingler session key).
              if (event._tag === "Started" && event.sessionId.length > 0) {
                yield* SessionStore.setResumeId(sessionId, chatId, event.sessionId).pipe(
                  Effect.ignore
                )
              }
              // Remember an edit's target path so its ToolEnd can tie back to a step.
              if (event._tag === "ToolStart" && EDIT_TOOLS.has(event.name) && event.target) {
                yield* Ref.update(editTargets, (m) => new Map(m).set(event.id, event.target!))
              }
              // Canonical plan writes must land BEFORE the event is offered.
              // `Done` makes the renderer leave its invoked stream immediately;
              // publishing it first lets that cancellation interrupt everything
              // below the offer, stranding a fully verified document in
              // `approved`/`executing`.
              if (event._tag === "Done") {
                yield* ContextManager.settle(chatId).pipe(Effect.ignore)
                yield* finalizePlanVerification()
                const settledText = next.parts
                  .filter((part) => part._tag === "Text")
                  .map((part) => part.text)
                  .join("\n")
                yield* memoryService.captureSettledSession({
                  sessionId,
                  chatId,
                  turnId: next.id,
                  cli,
                  userText: text,
                  assistantText: settledText,
                  settledAt: new Date().toISOString(),
                  retrieval: yield* Ref.get(memoryRetrieval)
                }).pipe(Effect.ignore)
              }
              // Amendment diagnostics are part of the canonical assistant
              // message, so live consumers must receive the same appended text
              // before the terminal event makes them stop reading the stream.
              if (liveAmendmentFeedback !== null) {
                yield* out.offer({
                  _tag: "Assistant",
                  text: liveAmendmentFeedback
                })
              }
              yield* out.offer(event)
              // After the tool card lands, reconcile plan progress off a successful edit.
              if (event._tag === "ToolEnd" && event.status === "success") {
                yield* markPlanProgress(event.id)
              }
              // Hand every context reading to the manager, but only let a SETTLED
              // turn start a digest.
              //
              // Claude and opencode report usage per assistant message, so a turn
              // that uses tools reports several times before it ends. Summarising
              // from one of those mid-turn readings would capture a transcript
              // whose last message is still streaming, and the digest's
              // `throughMessageId` would then cause the rest of that same turn to
              // be skipped at swap time — neither summarised nor replayed.
              //
              // `Done` is the only point at which the transcript is coherent.
              if (event._tag === "Usage") {
                yield* ContextManager.observe(chatId, event.tokens, event.window ?? null).pipe(
                  Effect.ignore
                )
              }
              // `Done` says WHEN to decide, never WHAT the context is. Its
              // `tokens` is the run's cumulative spend (see the Claude adapter),
              // which counts resident context once per tool call — reading it as
              // occupancy meant a long tool-using turn reported several times the
              // window size and compacted on every single turn, at a threshold
              // that moved with the tool count rather than the context. The
              // manager uses the latest `Usage` reading instead.
              // A hard context failure has no Done event, so the ordinary settle
              // path above can never prepare a digest. Force one from the
              // persisted last-good reading; the next turn can then swap onto
              // the compacted primer instead of failing against the same thread
              // forever.
              if (
                event._tag === "Failed" &&
                isContextOverflowFailure(event.message)
              ) {
                yield* ContextManager.compactNow(chatId, {
                  waitForReady: true
                }).pipe(Effect.ignore)
              }
            })).pipe(Effect.provide(env), Effect.asVoid)

          const canUseTool = (req: PermissionRequest): Effect.Effect<PermissionDecision> =>
            Effect.gen(function* () {
              // Re-read the live mode each call so an in-run change (e.g. a plan
              // approval restoring the exec mode) takes effect on this same turn.
              const liveMode = (yield* Ref.get(modes)).get(chatId) ?? mode
              if (verdict(liveMode, allow, req, planAutoRun) === "allow") return "allow" as const
              const gn = yield* nextId
              const gateId = `g_${sessionId}_${gn}`
              const gate = buildGate(gateId, req)
              // `approvals` announces the gate itself, so registration cannot lose
              // the race against a decision — see `awaitGate`.
              return yield* approvals.awaitGate(
                sessionId,
                chatId,
                gateId,
                gate,
                emit({ _tag: "GateRequested", gate })
              )
            })

          const askQuestion = (
            request: QuestionRequest
          ): Effect.Effect<ReadonlyArray<QuestionAnswer>> =>
            Effect.gen(function* () {
              const answers = yield* approvals.awaitAnswers(
                sessionId,
                chatId,
                request.id,
                emit({ _tag: "QuestionRequested", request })
              )
              // Record the answers onto the assistant turn's question part — both
              // the live accumulator (so later emits don't clobber it) and the
              // persisted transcript (so a reload doesn't re-show the question).
              yield* Ref.update(acc, (m) => setQuestionAnswers(m, request.id, answers))
              yield* TranscriptStore.patchLast(chatId, (m) => setQuestionAnswers(m, request.id, answers)).pipe(
                Effect.provide(env),
                Effect.ignore
              )
              return answers
            })

          const proposePlan = (
            plan: PlanPrd,
            submittedBlock?: string
          ): Effect.Effect<PlanDecision> =>
            Effect.gen(function* () {
              let basePlanId: string | undefined
              let previousStages: ReadonlyArray<PlanPrdStage> = []
              if (worktreePath.length > 0) {
                const current = yield* PlanStore.readDocument(
                  worktreePath,
                  sessionId,
                  chatId
                ).pipe(Effect.provide(env))
                basePlanId =
                  current !== null &&
                  current.producingChatId === chatId &&
                  current.status !== "done" &&
                  current.status !== "rejected"
                    ? current.id
                    : undefined
                if (basePlanId !== undefined && current !== null) {
                  previousStages = current.plan.stages
                }
              }
              const compiled =
                orchestrating && workerRouting !== null
                  ? compileOrchestrationPlan(plan, workerRouting, { previousStages })
                  : null
              const proposedPlan = compiled?.valid === true ? compiled.plan : plan
              const approvalPlanId = basePlanId ?? randomUUID()
              const revisingCanonicalPlan = basePlanId !== undefined
              // The Plan-shaped card emitted to the transcript; replaced by the
              // exact canonical projection once PlanStore promotes it.
              let canonicalPlan: Plan = planDocumentToPlan({
                id: approvalPlanId,
                sessionId,
                producingChatId: chatId,
                revision: 1,
                status: "proposed",
                plan: proposedPlan,
                updatedAt: new Date().toISOString(),
                updatedBy: "agent"
              })
              // Register the approval waiter BEFORE PlanStore makes the proposal
              // visible to file watchers. The announce effect then promotes and
              // publishes the exact canonical projection while the gate is live.
              return yield* approvals.awaitPlan(
                sessionId,
                chatId,
                approvalPlanId,
                Effect.gen(function* () {
                  if (worktreePath.length > 0) {
                    const promotion = yield* PlanStore.promote(
                      sessionId,
                      worktreePath,
                      chatId,
                      proposedPlan,
                      {
                        id: approvalPlanId,
                        ...(basePlanId === undefined ? {} : { basePlanId }),
                        status: "proposed"
                      }
                    ).pipe(Effect.provide(env), Effect.either)
                    if (promotion._tag === "Left") {
                      yield* emit({
                        _tag: "Failed",
                        message: promotion.left.message
                      })
                      return yield* Effect.interrupt
                    }
                    // PlanStore owns validation and amendment reconciliation.
                    // Publish exactly its projection so transcript and Plan Review
                    // share one identity.
                    canonicalPlan = promotion.right.plan
                  }
                  // The agent streams the plan's JSON block before we promote it.
                  // Once the canonical Plan card owns the document, remove only that
                  // exact visible transport. Payload-only plans omit `submittedBlock`.
                  if (submittedBlock !== undefined) {
                    yield* turnMutation.withPermits(1)(
                      Effect.gen(function* () {
                        const current = yield* Ref.get(acc)
                        const next = {
                          ...current,
                          parts: current.parts.flatMap(
                            (part): ReadonlyArray<ContentPart> => {
                              if (part._tag !== "Text") return [part]
                              const text = stripPlanJsonBlock(part.text, submittedBlock)
                              return text.length === 0 ? [] : [{ ...part, text }]
                            }
                          )
                        }
                        yield* Ref.set(acc, next)
                        yield* TranscriptStore.patchLast(chatId, () => next).pipe(
                          Effect.provide(env),
                          Effect.ignore
                        )
                      })
                    )
                  }
                  yield* emit(
                    revisingCanonicalPlan
                      ? { _tag: "PlanUpdated", plan: canonicalPlan }
                      : { _tag: "PlanProposed", plan: canonicalPlan }
                  )
                })
              )
            })

          // The marker-free DRAFT path: persist an emitted plan as a draft
          // `PlanDocument` so Plan Review populates for iteration, WITHOUT the
          // `approvals.awaitPlan` gate `proposePlan` parks on. The file write is
          // all it takes — `Plan.watch` streams the canonical doc to the
          // renderer. Never downgrade a real plan the operator already owns: only
          // fill an empty slot, or refresh an existing AGENT draft (amend, so the
          // revision advances as the orchestrator iterates). A user-authored draft
          // is the operator actively editing — an agent draft must not reconcile
          // over it and silently discard their content. Best-effort — a plan write
          // must never fail the turn.
          const saveDraftPlan = (plan: PlanPrd, block?: string): Effect.Effect<void> =>
            worktreePath.length === 0
              ? Effect.void
              : PlanStore.readDocument(worktreePath, sessionId, chatId).pipe(
                  Effect.provide(env),
                  Effect.orElseSucceed(() => null),
                  Effect.flatMap((current) =>
                    current !== null &&
                    (current.status !== "draft" || current.updatedBy === "user")
                      ? Effect.void
                      : PlanStore.promoteDocument(worktreePath, {
                          sessionId,
                          producingChatId: chatId,
                          plan,
                          status: "draft",
                          author: "agent",
                          ...(current !== null
                            ? { basePlanId: current.id }
                            : {})
                        }).pipe(Effect.provide(env), Effect.ignore)
                  ),
                  // Record the captured transport so the settle handler scrubs
                  // exactly this block from the reply (never a quoted example).
                  Effect.zipRight(
                    block === undefined
                      ? Effect.void
                      : Ref.update(savedDraftBlocks, (blocks) => [...blocks, block])
                  )
                )

          // Publish live handles so comment/revise/approve can reach this run;
          // torn down when the run ends so out-of-band calls become no-ops.
          const steer = (
            text: string,
            images: ReadonlyArray<Attachment>,
            captureReply = false
          ): Effect.Effect<
            | {
                readonly status: "accepted"
                readonly user: Message
                readonly assistant: Message
                readonly replyWaiter: RunReplyWaiter | null
              }
            | { readonly status: "deferred" | "unsupported" }
          > =>
            turnMutation.withPermits(1)(Effect.gen(function* () {
              const handler = yield* Ref.get(turnSteer)
              if (handler === null) {
                // Codex publishes and RETRACTS its handle within a run (native
                // compaction), so "no handle" there is a phase → `deferred`.
                // Everywhere else it means this run has no channel at all —
                // including runs that never go through a steering adapter, like a
                // plan execution — and `unsupported` is what licenses the renderer
                // to stop and replay, which is the only thing that would work.
                //
                // Claude stays on `unsupported` deliberately, even though it CAN
                // steer: its handle is registered a beat into the run, and the only
                // caller that can lose that race is the operator's own "Send now",
                // whose fallback is exactly right. The queue's automatic flush is
                // unaffected — it marks its steers `auto`, which forbids the stop.
                return { status: cli === "codex" ? "deferred" : "unsupported" } as const
              }
              const replyWaiter: RunReplyWaiter | null = captureReply
                ? yield* makeSteeredReplyWaiter
                : null
              if (replyWaiter !== null) {
                yield* Ref.set(steeredReply, replyWaiter)
              }
              const steered = yield* invokeSteer(handler, text, images)
              const outcome = steered === "accepted" ? "accepted" : "deferred"
              if (outcome !== "accepted") {
                if (replyWaiter !== null) yield* Ref.set(steeredReply, null)
                return { status: outcome } as const
              }

              const at = yield* Effect.sync(() => new Date().toISOString())
              const settled = settleStreaming(yield* Ref.get(acc))
              const user = userMessage(`u_${chatId}_${yield* nextId}`, text, at, images)
              const assistant = assistantMessage(`a_${chatId}_${yield* nextId}`, at)
              yield* Ref.set(acc, assistant)
              yield* TranscriptStore.patchLast(chatId, () => settled).pipe(Effect.ignore)
              yield* TranscriptStore.append(chatId, user)
              yield* TranscriptStore.append(chatId, assistant)
              return {
                status: "accepted",
                user,
                assistant,
                replyWaiter
              } as const
            })).pipe(Effect.provide(env))

          yield* Ref.update(active, (m) =>
            new Map(m).set(chatId, {
              readPlan,
              applyPlan,
              markPlanExecution: (planId) => Ref.set(executingPlanId, planId),
              steer,
              subagents: () =>
                Ref.get(activeSubagents).pipe(
                  Effect.map((subagents) => [...subagents.values()])
                ),
              clearReplyWaiter: (waiter) =>
                Ref.update(steeredReply, (current) =>
                  current === waiter ? null : current
                ),
              replyGate
            })
          )

          /** Identifies THIS run, so its cleanup can't evict a successor's fiber. */
          const token: RunToken = {}

          // Publish this run's per-task stop handle for THIS chat. Registering
          // also orphans this chat's own previously-registered tasks — their
          // handle is being replaced and no longer resolves to anything stoppable.
          const registerBackgroundStop = (stop: StopBackgroundTask) =>
            BackgroundTaskStore.registerStop(sessionId, chatId, stop).pipe(Effect.provide(env), Effect.ignore)
          const registerTurnSteer = (handler: SteerTurn | null) => Ref.set(turnSteer, handler)

          // Record the compaction on THIS turn, before the harness says anything.
          //
          // The transcript is never truncated — the user can still scroll back
          // through the whole conversation. This marker exists so that what the
          // model kept is legible: without it the context meter would simply drop
          // with no explanation, which is how `/compact` behaves today and exactly
          // why it feels like the app lost your history.
          if (digest !== null) {
            yield* emit({ _tag: "ContextCompacted", digest, tokensBefore: compactedFrom })
          }

          const adapterRun = adapter.run(chatId, spec, {
            emit,
            canUseTool,
            askQuestion,
            proposePlan,
            saveDraftPlan,
            registerBackgroundStop,
            registerTurnSteer
          })
          const guardedRun =
            session !== null && workspaceModeOf(session) === "direct"
              ? Effect.raceFirst(
                  adapterRun,
                  Effect.forever(
                    Effect.sleep("250 millis").pipe(
                      Effect.zipRight(
                        Effect.gen(function* () {
                          const liveBranch = yield* branchAt(worktreePath)
                          if (liveBranch === session.branch) return
                          const actual =
                            liveBranch === null
                              ? "detached HEAD"
                              : `branch "${liveBranch}"`
                          return yield* Effect.fail(
                            new CliExecError({
                              kind: session.cli,
                              message:
                                `This direct session was stopped because its repository ` +
                                `moved from branch "${session.branch}" to ${actual}. Switch ` +
                                `the repository back to "${session.branch}" before continuing.`
                            })
                          )
                        })
                      )
                    )
                  )
                )
              : adapterRun
          const run = guardedRun.pipe(
            // An operator stop arrives as an interruption. Record it as the turn's
            // terminal event so the message settles (and the transcript says why)
            // rather than being left mid-stream forever. Finalizers run
            // uninterruptibly, so this emit completes before the mailbox closes.
            Effect.onInterrupt(() =>
              // Flagged BEFORE the emit, so the instrumentation still learns the
              // exit was an interrupt even in the case we most want to catch:
              // the one where this emit does not land.
              Ref.set(wasInterrupted, true).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    // Don't overwrite a reason the turn already has. The
                    // first-event watchdog settles the turn with a message that
                    // says what went wrong and THEN interrupts, so an
                    // unconditional emit here would bury it under a bare
                    // "Stopped." — telling the operator their own action halted a
                    // turn they never touched.
                    if (yield* Ref.get(sawTerminal)) return
                    yield* emit({ _tag: "Failed", message: STOPPED_NOTE })
                  })
                )
              )
            ),
            // A stop is not a crash — don't report the operator's own interrupt as
            // "the agent run failed" on top of the note we just wrote.
            Effect.catchAllCause((cause) => {
              if (Cause.isInterruptedOnly(cause)) return Effect.void
              const failure = Option.getOrUndefined(Cause.failureOption(cause))
              return emit({
                _tag: "Failed",
                message: failure instanceof CliExecError ? failure.message : "The agent run failed."
              })
            }),
            Effect.ensuring(
              Ref.update(active, (m) => {
                const nextMap = new Map(m)
                nextMap.delete(chatId)
                return nextMap
              })
            ),
            Effect.ensuring(
              // Deregister THIS run only. A session's slot can already belong to a
              // NEWER run by the time this one finishes: "send now" interrupts the
              // current turn and starts the next without waiting for the stop to
              // land (the renderer fires it and moves on), so the two overlap.
              // Deleting by session id alone would evict the new run's fiber, and
              // the next stop would find nothing and quietly do nothing — leaving
              // a turn nobody can halt. The token is in scope here; the fiber
              // doesn't exist yet.
              //
              // Untested, deliberately: the obvious test can't reach this. This
              // finalizer runs BEFORE `out.end`, and a consumer only returns once
              // the stream ends — so any test that awaits run 1 before starting
              // run 2 has already missed the overlap, and passes with or without
              // the guard. Reproducing it needs run 1 still unwinding while run 2
              // registers, which is a timing construction, not a fact about the
              // code. Reviewed rather than pinned.
              Ref.update(fibers, (m) => {
                if (m.get(chatId)?.token !== token) return m
                const nextMap = new Map(m)
                nextMap.delete(chatId)
                return nextMap
              })
            ),
            /**
             * Record an exit that never settled the turn.
             *
             * Ordered INSIDE `out.end` (it is piped before it, so it runs first)
             * purely so the reading is taken while the run's state is still the
             * one that produced it; nothing here touches the mailbox.
             *
             * `exitInterrupted` is the field that should break the tie: if
             * unsettled exits are all interrupts, the stop path is racing its own
             * `Failed` emit; if they are not, something upstream is ending the
             * stream without a terminal event at all.
             */
            Effect.ensuring(
              Effect.gen(function* () {
                if (yield* Ref.get(sawTerminal)) return
                const fs = yield* FileSystem.FileSystem
                const paths = yield* AppPaths
                const record = {
                  at: new Date().toISOString(),
                  sessionId,
                  cli: session?.cli ?? null,
                  images: images.length,
                  events: yield* Ref.get(eventCount),
                  lastEvent: yield* Ref.get(lastEvent),
                  exitInterrupted: yield* Ref.get(wasInterrupted)
                }
                yield* fs.writeFileString(
                  `${paths.root}/unsettled-turns.jsonl`,
                  `${JSON.stringify(record)}\n`,
                  { flag: "a" }
                )
              }).pipe(Effect.provide(env), Effect.ignore)
            ),
            Effect.ensuring(out.end)
          )
          /**
           * Forked DETACHED, not into the request stream's scope.
           *
           * The renderer leaves `running` the moment `Done` lands, which stops the
           * invoked stream and closes its scope — so a scoped fork meant the
           * harness was killed at turn end, every time. That silently made the
           * dock a liar: a backgrounded task went on being listed as "running"
           * while the process servicing it was already dead, and its stop button
           * addressed a handle into nothing. Background work has to outlive the
           * turn that started it or the feature does not exist.
           */
          const fiber = yield* Effect.forkDaemon(run)
          yield* Ref.update(fibers, (m) =>
            new Map(m).set(chatId, { sessionId, chatId, fiber, token, settled: sawTerminal })
          )

          /**
           * How long a settled run is given to finish under its own steam.
           *
           * A harness that ends its stream at turn end is already unwinding, and
           * interrupting it there races the finalizers that persist the transcript
           * — insisting too early truncates the very turn just completed. Only a
           * run still alive after this is genuinely lingering.
           */
          const SELF_EXIT_GRACE = "5 seconds"

          /** Unsettled background tasks belonging to this chat, right now. */
          const liveTasks = BackgroundTaskStore.liveFor(sessionId, chatId).pipe(
            Effect.provide(env),
            Effect.orElseSucceed(() => 0)
          )

          /** Read the run's fate from the policy in `run-lifetime.ts`. */
          const fate = (consumerAttached: boolean) =>
            Effect.gen(function* () {
              return runLifetime({
                turnSettled: yield* Ref.get(sawTerminal),
                consumerAttached,
                liveBackgroundTasks: yield* liveTasks
              })
            })

          /**
           * Detaching mid-turn stops the agent; detaching after it settled does not.
           *
           * The mailbox is ended either way — once nothing is reading it, every
           * further event is a write into a buffer that will never be drained.
           */
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const decision = yield* fate(false)
              if (decision.verdict === "end") yield* Fiber.interrupt(fiber)
              yield* out.end
            })
          )

          /**
           * Outlive the turn for as long as there is background work, then stop.
           *
           * Polled because settlement arrives through the harness's own signals (a
           * completion bookend, an operator stop) which land in the task registry —
           * there is no completion channel to await. A second is far below human
           * patience for "is it finished yet" and costs one map read.
           */
          yield* Effect.forkDaemon(
            Effect.gen(function* () {
              yield* Deferred.await(turnSettled)
              while ((yield* fate(true)).verdict === "run") {
                yield* Effect.sleep("1 seconds")
              }
              yield* Fiber.await(fiber).pipe(
                Effect.timeout(SELF_EXIT_GRACE),
                Effect.catchAll(() => Fiber.interrupt(fiber))
              )
            })
          )

          // Watchdog the FIRST event.
          //
          // A harness child that hangs before it says anything is invisible to
          // every guarantee we have: `drainRun` in the renderer only synthesises
          // a terminal event when the stream ends, `Effect.ensuring(out.end)`
          // only runs when `adapter.run` returns, and the unsettled-turn
          // instrumentation below is a FINALIZER — none of them can fire on a
          // run that neither emits nor exits. The operator is left with a
          // pulsing eyebrow over an empty message and no way to tell whether
          // anything is happening. Only a timer can see this.
          //
          // Deliberately checks `eventCount` rather than racing the run: a
          // harness that emitted even once is alive, and killing a slow-but-live
          // turn would be far worse than the bug. Interrupting reuses the
          // existing stop path, so the transcript settles the same way an
          // operator stop does — except we say why.
          yield* Effect.forkScoped(
            Effect.sleep(FIRST_EVENT_DEADLINE).pipe(
              Effect.zipRight(
                Effect.gen(function* () {
                  if ((yield* Ref.get(eventCount)) > 0) return
                  yield* emit({
                    _tag: "Failed",
                    message: `${session.cli} produced no output for ${FIRST_EVENT_DEADLINE}. The turn was cancelled — send your message again.`
                  })
                  yield* Fiber.interrupt(fiber)
                })
              )
            )
          )
          return Mailbox.toStream(out)
        })
      )

    function prompt(
      sessionId: string,
      chatId: string,
      text: string,
      images: ReadonlyArray<Attachment> = [],
      reasoning?: ReasoningSetting | null,
      planExecutionId?: string,
      externalInstruction?: ExternalInstructionIdentity,
      displayText?: string
    ): Stream.Stream<StreamEvent, never, PromptEnv> {
      return Stream.unwrapScoped(
        Effect.gen(function* () {
          const lock = yield* chatLock(chatId)
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (
                externalInstruction !== undefined &&
                (yield* TranscriptStore.hasExternalInstruction(chatId, externalInstruction))
              ) {
                return Stream.fromIterable<StreamEvent>([{
                  _tag: "ExternalInstructionAccepted",
                  identity: externalInstruction,
                  duplicate: true
                }])
              }
              // Concurrent chats in one session are allowed, but a single chat is
              // single-flight: two runs on ONE chatId would race the `fibers`
              // slot (line ~1503) — run A's fiber orphaned and unstoppable since
              // `stop` reads only the latest — and both would mint positional
              // message ids from the same transcript snapshot, colliding. Refuse
              // the second (a racing double-send, a second window). Distinct
              // chats reserve distinct owners and are always admitted.
              // This run's identity as the reservation holder. Minted here, not
              // reused from `RunToken`, because the slot is claimed before the run
              // (and its token) exists — and because a reclaim must be able to
              // supersede a holder that is still unwinding.
              const holder: RunHolder = {}
              const admitted = yield* reserveSessionRun(sessionId, chatId, holder)
              if (!admitted) {
                // A refusal is only legitimate while a run is actually live.
                // The reservation is released by a finalizer on the STREAM's
                // scope, and a renderer that abandons the stream without
                // interrupting it — a window reload, an HMR full reload, a
                // renderer crash — never closes that scope. The main process
                // (and this module-level map) outlives the renderer, so the
                // chat is refused forever, and the operator has no stop button
                // to press because their reloaded renderer shows the chat idle.
                //
                // `fibers` is the authoritative record of a live run, and it is
                // written under this same chat lock immediately after the
                // reservation (and cleared in the run's `ensuring`), so
                // "reserved but no live fiber" is not a race — it is proof the
                // reservation outlived its run. Reclaim it rather than making
                // the operator restart the app.
                const running = (yield* Ref.get(fibers)).get(chatId)
                // A run whose turn has SETTLED holds nothing worth protecting.
                // Single-flight exists so two turns can't race one chat's
                // transcript and `fibers` slot; once the terminal event is out,
                // that turn is over and the next prompt is not a race with it.
                // Reading fiber liveness alone made a backgrounded task — which
                // deliberately keeps the harness consuming long past `Done` —
                // refuse its own chat for as long as the task ran, with the
                // composer showing an idle send button and nothing to stop.
                const stale =
                  running === undefined ||
                  Option.isSome(yield* Fiber.poll(running.fiber)) ||
                  (yield* Ref.get(running.settled))
                if (!stale) {
                  return Stream.fromIterable<StreamEvent>([{
                    _tag: "Failed",
                    message: "This chat is already running. Wait for it to finish or stop it before sending again."
                  }])
                }
                yield* reclaimSessionRun(sessionId, chatId, holder)
              }
              yield* Effect.addFinalizer(() => releaseSessionRun(sessionId, chatId, holder))
              return yield* promptSetup(
                sessionId,
                chatId,
                text,
                images,
                reasoning,
                planExecutionId,
                externalInstruction,
                displayText
              ).pipe(
                Effect.catchAll((error) =>
                  Effect.succeed(
                    Stream.fromIterable<StreamEvent>([{
                      _tag: "Failed",
                      message:
                        error instanceof CliExecError
                          ? error.message
                          : "The agent run could not start."
                    }])
                  )
                )
              )
            })
          )
        })
      )
    }

    const steer = (
      sessionId: string,
      chatId: string,
      text: string,
      images: ReadonlyArray<Attachment> = []
    ) =>
      Effect.gen(function* () {
        const run = (yield* Ref.get(active)).get(chatId)
        if (run === undefined) return { status: "unsupported" } as const
        const session = yield* getSessionOrNull(sessionId)
        if (!session?.chats.some((chat) => chat.id === chatId)) {
          return { status: "unsupported" } as const
        }
        const result = yield* run.steer(text, images)
        return result.status === "accepted"
          ? {
              status: result.status,
              user: result.user,
              assistant: result.assistant
            } as const
          : result
      })

    /**
     * Forget a chat's per-chat state (the chat was closed). The caller stops the
     * run first, so `fibers`/`active` are already torn down; this drops the maps
     * keyed by chatId that otherwise grow for the life of the process — most
     * importantly `locks`, one semaphore of which is minted per chat and never
     * otherwise removed.
     */
    const forgetChat = (chatId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const drop = <V>(ref: Ref.Ref<Map<string, V>>) =>
          Ref.update(ref, (m) => {
            if (!m.has(chatId)) return m
            const next = new Map(m)
            next.delete(chatId)
            return next
          })
        yield* drop(locks)
        yield* drop(modes)
        yield* approvals.forgetChat(chatId)
        yield* drop(priorModes)
        yield* drop(execDefaults)
      })

    return {
      /**
       * Whether any session is mid-run. Read by the learning daemon so a
       * background tick never contends for the rate limits the operator is
       * actively waiting on — the runner already owns this map, so exposing it
       * beats a second source of truth that could disagree.
       */
      anyRunning: anySessionRunActive,
      prompt,
      decideGate,
      answerQuestion,
      setMode,
      steer,
      planParticipants,
      steerPlanParticipant,
      stop,
      commentPlanStep,
      revisePlan,
      approvePlan,
      resumePlan,
      forgetChat
    } as const
  })
}) {}
