
import type {
  AgentRosterEntry,
  ContextDigest,
  Attachment,
  ExplanationPayload,
  ExternalInstructionIdentity,
  GateDecision,
  Message,
  PeerAgentMessageResult,
  PermissionMode,
  AgentEndpointId,
  AgentRuntimeId,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
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
  AgentRunError,
  BranchDriftError,
  CURRENT_RUNTIME_CONTRACTS,
  defaultModeFor,
  isFileMutationTool,
  piEndpointId,
  setQuestionAnswers,
  settleStreaming,
  STOPPED_NOTE,
  userMessage,
  workspaceModeOf
} from "@jingler/core"
import { FileSystem, type Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Cause, Deferred, Effect, Fiber, Mailbox, Option, Ref, Stream } from "effect"
import { adhdNote } from "./adhd-prompt.js"
import { modeToRestore } from "./exec-mode.js"
import { isTerminal, routeOf } from "./turn-events.js"
import {
  composeTurnPrompt,
  leadsWithCommand,
  managedToolsNote,
  researchFirstNote
} from "./turn-prompt.js"
import { buildGate, makeApprovals, verdict } from "./approvals.js"
import { runLifetime } from "./run-lifetime.js"
import { routePeerAgentMessage } from "./peer-agent-coordination.js"
import { plannotatorReviewPending } from "./plannotator-recovery.js"
import { questionNote } from "./question-prompt.js"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { AgentTurnDriver } from "./agent-turn-driver.js"
import type {
  PermissionDecision,
  PermissionRequest,
  AgentTurnSpec,
  SteerTurn,
  StopBackgroundTask
} from "./agent-turn-driver.js"
import { ContextManager } from "./context-manager.js"
import { renderPrimer, tailAfter } from "./context-digest.js"
import { healedWorktreePath } from "./runtime/persistence/worktree-path.js"
import { branchAt, ensureWorktreeLinked } from "./git.js"
import { BrowserControlMcpService,
  type BrowserControlMcpAttachment
} from "./browser-control-mcp-service.js"
import type { SecretStore } from "./secret-store.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { ExplanationStore } from "./explanation-store.js"
import {
  appendSteeredReply,
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

/**
 * Coalescing window for streaming-turn transcript writes — see the
 * "Coalesced transcript persistence" note inside `promptSetup`. Long enough to
 * collapse a burst of deltas into one rewrite, short enough that a crash loses
 * well under a second of a turn that the harness will re-stream anyway.
 */
const TRANSCRIPT_FLUSH_MS = 250

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


type RunReplyWaiter = SteeredReplyWaiter

/** Windows separators → POSIX for stable touched-file reporting. */
const normalizePath = (path: string): string => path.replace(/\\/g, "/")

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
  readonly clearReplyWaiter: (waiter: RunReplyWaiter) => Effect.Effect<void>
  readonly replyGate: Effect.Semaphore
}

const updateSessionCompletion = (
  event: StreamEvent,
  completionDeclared: Ref.Ref<boolean>,
  liveTasks: Effect.Effect<number>,
  active: Ref.Ref<Map<string, ActiveRun>>,
  sessionId: string,
  out: Mailbox.Mailbox<StreamEvent>
) => Effect.gen(function* () {
  if (event._tag === "SessionCompletionDeclared") {
    yield* Ref.set(completionDeclared, true)
    return
  }
  if (event._tag !== "Done" || !(yield* Ref.get(completionDeclared))) return
  if ((yield* liveTasks) > 0 || (yield* Ref.get(active)).size > 1) return
  const persisted = yield* SessionStore.setStatus(sessionId, "settled").pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false))
  )
  if (persisted) yield* out.offer({ _tag: "SessionSettled" })
})

type PromptEnv =
  | AgentTurnDriver
  | ConfigService
  | SessionStore
  | TranscriptStore
  | BackgroundTaskStore
  | ContextManager
  | BrowserControlMcpService
  | SecretStore
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | AppPaths

/**
 * Runs a prompt against the selected harness. `prompt` returns a
 * `Stream<StreamEvent>` — the harness-agnostic seam the renderer subscribes to —
 * while, in-band, it applies the session's HITL mode, pauses on gates, folds each
 * event into the persisted transcript, and re-emits it. Gate/mode state lives in
 * this singleton service so `decideGate`/`setMode` (separate RPCs) can reach the
 * paused run.
 */
export class AgentRunner extends Effect.Service<AgentRunner>()("@jingler/AgentRunner", {
  dependencies: [ExplanationStore.Default],
  effect: Effect.gen(function* () {
    const explanationStore = yield* ExplanationStore
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
    const touchedFiles = yield* Ref.make(new Map<string, ReadonlyArray<string>>())
    // chatId → the fiber running the agent, so `stop` can interrupt it.
    // Interruption is the ONLY thing that reaches the underlying provider turn:
    // the production driver interrupts pi in an `onInterrupt` finalizer. Nothing
    // else gets there — scripted runs have no separate process-level stop, and a
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

    const setModel = (
      sessionId: string,
      chatId: string,
      connectionId: ProviderConnectionId,
      providerId: ProviderId,
      modelId: ProviderModelId
    ) =>
      Effect.gen(function* () {
        const lock = yield* chatLock(chatId)
        yield* lock.withPermits(1)(
          SessionStore.setProviderModel(
            sessionId,
            chatId,
            connectionId,
            providerId,
            modelId
          )
        )
        return yield* SessionStore.get(sessionId)
      })

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
          const adapter = yield* AgentTurnDriver
          const { session, chat, connectionId, modelId } = yield* resolveTurnChat(sessionId, chatId)
          yield* TranscriptStore.adoptLegacy(sessionId, chatId)

          const sessionMode =
            (yield* Ref.get(modes)).get(chatId) ?? chat.mode ?? defaultModeFor()
          const allow = new Set<string>([
            ...(yield* approvals.allowlistFor(chatId)),
            ...(chat.allowlist ?? [])
          ])
          const workspaceConfig = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          // Read per turn, not per session: flipping ADHD mode in Settings takes
          // effect on the very next message of an already-running session.
          const adhdMode = workspaceConfig?.adhdMode ?? ADHD_MODE_DEFAULT
          // Cache the user's configured default exec mode so approving a plan can
          // restore it.
          const execDefault = defaultModeFor()
          yield* Ref.update(execDefaults, (m) => new Map(m).set(chatId, execDefault))
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
          // the worktree sits perfectly intact one name over.
          //
          // Costs one `stat` on the overwhelmingly common healthy path.
          const worktreePath = yield* resolveTurnWorktree(sessionId, session)
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
          const { digest, compactedFrom, primer, planPointer } = yield* prepareTurnDigest(
            session,
            chatId
          )
          // ADHD mode rides in the same per-turn prefix as the primer and plan
          // pointer so a Settings change applies immediately. Its own scope makes
          // the format dormant during work and active only for the final summary.
          const adhd = adhdMode ? adhdNote() : null
          // Not optional, and not a setting: an agent that asks in prose is an
          // agent whose question never reaches the operator. Claude has the
          // `AskUserQuestion` tool the adapter intercepts, Codex has the fenced
          // block the adapter parses — but nothing tells either of them to
          // prefer it, so both default to asking in chat text that renders as
          // an unanswerable paragraph. Rides the same per-turn prefix as ADHD
          // mode, for the same reason: no system-prompt hook is shared by every
          // harness, and this has to survive a mid-session harness switch.
          const ask = questionNote()
          // How this harness submits a plan. Null for Claude — the adapter passes
          // `planModeInstructions` as a real SDK option there, and saying it twice
          // would compete with the `ExitPlanMode` tool the harness is steered
          // toward. With Jingler tools disabled, the harness owns planning and
          // receives none of Jingler's structured plan protocol.
          const priorMessages = yield* TranscriptStore.list(chatId).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const activePlanExecutionId = null
          const planProtocol = null
          const operatorText = displayText ?? text
          const promptText = text
          // Browser control is exclusive within one repository session but
          // independent sessions receive isolated native views and may QA in
          // parallel. The scoped lease revokes its bearer when the run ends.
          const browserAttachment = yield* acquireRuntimeBrowser(chat.runtimeId, sessionId, chatId)
          const spec = prepareTurnSpec(
            session,
            priorMessages,
            sessionId,
            chatId,
            browserAttachment,
            chat,
            connectionId,
            modelId,
            mode,
            activePlanExecutionId,
            digest,
            worktreePath,
            promptText,
            primer,
            planPointer,
            adhd,
            ask,
            planProtocol,
            images,
            reasoning
          )

          // Clear the PERSISTED id too, so a crash between here and the harness
          // reporting its new id can't leave the session pointing at a thread
          // whose context we have already decided to abandon.
          yield* clearCompactedSessionId(sessionId, chatId, digest)

          // Capture the persistence services so `emit`/`run` handed to the
          // adapter have no residual requirements (R = never).
          const env = yield* Effect.context<
            | TranscriptStore
            | SessionStore
            | BackgroundTaskStore
            // `emit` hands every context reading to the manager, which may fork a
            // digest run — so the manager's own dependencies have to be captured
            // here too, or `emit`
            // stops being `R = never` and the whole fold fails to type.
            | ContextManager
            | ConfigService
            | AgentTurnDriver
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
          const assistant = assistantMessage(`a_${chatId}_${an}`, now, chat.providerId)
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
          const turnSteer = yield* Ref.make<SteerTurn | null>(null)
          const steeredReply = yield* Ref.make<RunReplyWaiter | null>(null)
          const replyGate = yield* Effect.makeSemaphore(1)
          const turnMutation = yield* Effect.makeSemaphore(1)
          const out = yield* Mailbox.make<StreamEvent>()
          yield* acknowledgeExternalInstruction(out, externalInstruction)

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
          const completionDeclared = yield* Ref.make(false)
          /** Unsettled background tasks belonging to this chat, right now. */
          const liveTasks = BackgroundTaskStore.liveFor(sessionId, chatId).pipe(
            Effect.provide(env),
            Effect.orElseSucceed(() => 0)
          )
          /**
           * ── Coalesced transcript persistence ────────────────────────────────
           *
           * `TranscriptStore.patchLast` reads the whole transcript, decodes and
           * re-encodes the last message and rewrites the file. Doing that on
           * EVERY stream event — each text delta, each tool status tick — meant
           * a 20MB transcript was rewritten dozens of times a second during a
           * tool-heavy turn (measured: main's external buffers sawtoothing to
           * 600MB+, a 2.4GB peak footprint). The accumulator is the source of
           * truth; disk only needs to converge. So writes coalesce: at most one
           * flush per `TRANSCRIPT_FLUSH_MS`, and always an immediate one on a
           * terminal event so `Done`/`Failed` land before anything reads them.
           *
           * The delayed flush takes the same `turnMutation` permit as `emit`
           * and the steer path, so it can never interleave with a placeholder
           * append; and it re-reads `acc` when it runs, so it always writes the
           * newest state, never a stale capture.
           */
          const transcriptDirty = yield* Ref.make(false)
          const flushScheduled = yield* Ref.make(false)
          const flushTranscript: Effect.Effect<void> = Effect.gen(function* () {
            yield* Ref.set(transcriptDirty, false)
            const current = yield* Ref.get(acc)
            yield* TranscriptStore.patchLast(chatId, () => current).pipe(Effect.ignore)
          }).pipe(Effect.provide(env))
          const persistAccumulated = (event: StreamEvent): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (isTerminal(event)) return yield* flushTranscript
              yield* Ref.set(transcriptDirty, true)
              if (yield* Ref.get(flushScheduled)) return
              yield* Ref.set(flushScheduled, true)
              yield* Effect.forkDaemon(
                Effect.sleep(TRANSCRIPT_FLUSH_MS).pipe(
                  Effect.andThen(
                    turnMutation.withPermits(1)(
                      Effect.gen(function* () {
                        yield* Ref.set(flushScheduled, false)
                        if (yield* Ref.get(transcriptDirty)) yield* flushTranscript
                      })
                    )
                  )
                )
              )
            })
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
          // Fold each event into the assistant message + persist, then surface it.
          // Native steering enters from an RPC fiber, so serialize it with the
          // adapter's event producer. A turn/completed notification arriving in
          // the same stdout chunk as the steer response must land on the NEW
          // assistant placeholder, never race it and leave that placeholder open.
          const emit = (event: StreamEvent): Effect.Effect<void> =>
            turnMutation.withPermits(1)(Effect.gen(function* () {
              yield* updateSessionCompletion(
                event,
                completionDeclared,
                liveTasks,
                active,
                sessionId,
                out
              )
              // Codex can surface one app-server failure as both `turn.failed`
              // and `error`. The first terminal owns the turn; folding the
              // second printed the same context-overflow message twice.
              if (!(yield* claimTurnTerminal(event, sawTerminal, turnSettled))) return
                  // Tracked before the early returns below, so background-task and
                  // sub-agent events still count toward "what did this run actually
                  // emit" — a run that produced only sub-agent chatter and then
                  // vanished is a different failure from one that emitted nothing.
                  yield* Ref.update(eventCount, (n) => n + 1)
              yield* Ref.set(lastEvent, event._tag)
                  yield* appendTurnAssistantReply(steeredReply, event)
                  // Where this event belongs, and why, lives in `turn-events.ts`.
                  const route = routeOf(event)
              if (route !== "transcript") {
                    yield* ingestBackgroundTurnEvent(sessionId, chatId, event, route)
                yield* out.offer(event)
                return
              }
                  // A finished turn reports what it used. Accrued here rather than
                  // in the adapters so every harness lands in one place — and so a
                  // harness that reports nothing simply adds zero instead of needing
                  // its own bookkeeping.
                  yield* accountTurnUsage(sessionId, event)
                  const next = applyStreamEvent(yield* Ref.get(acc), event)
              yield* Ref.set(acc, next)
              yield* persistAccumulated(event)
                  // Persist the pi session id (carried on Started) so the NEXT
                  // prompt resumes this conversation — even after an app restart wiped
                  // the runtime's in-memory resume map. `event.sessionId` is the
                  // pi session id, not our `sessionId` (the Jingler session key).
                  yield* persistTurnSessionId(
                    sessionId,
                    chatId,
                    spec.runtimeId,
                    spec.endpointId,
                    event
                  )
                  // Remember an edit's target path so its ToolEnd can tie back to a step.
                  yield* rememberTurnFile(touchedFiles, chatId, worktreePath, event)
                  // Canonical plan writes must land BEFORE the event is offered.
                  // `Done` makes the renderer leave its invoked stream immediately;
                  // publishing it first lets that cancellation interrupt everything
                  // below the offer, stranding a fully verified document in
                  // `approved`/`executing`.
                  yield* settleCompletedTurn(chatId, event)
                  yield* out.offer(event)
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
                  yield* observeTurnContext(chatId, event)
                })).pipe(Effect.provide(env), Effect.asVoid)

          const canUseTool = (req: PermissionRequest): Effect.Effect<PermissionDecision> =>
            Effect.gen(function* () {
              // Re-read the live mode each call so an in-run change (e.g. a plan
              // approval restoring the exec mode) takes effect on this same turn.
              const liveMode = (yield* Ref.get(modes)).get(chatId) ?? mode
              if (verdict(liveMode, allow, req) === "allow") {
                return "allow" as const
              }
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


          const publishExplanation = (explanation: ExplanationPayload) =>
            worktreePath.length === 0
              ? Effect.void
              : explanationStore.publish(
                  worktreePath,
                  sessionId,
                  chatId,
                  explanation
                ).pipe(Effect.provide(env), Effect.asVoid)

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
            turnMutation.withPermits(1)(
                steerActiveTurn(
                  {
                    turnSteer,
                    steeredReply,
                    acc,
                    transcriptDirty,
                    nextId,
                    chatId,
                    providerId: chat.providerId
                  }, text, images,
                  captureReply
                )).pipe(Effect.provide(env))

          yield* Ref.update(active, (m) =>
            new Map(m).set(chatId, {
              steer,
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
          yield* emitCompactedContext(emit, digest, compactedFrom)

          const listPeerAgents = (): Effect.Effect<ReadonlyArray<AgentRosterEntry>> =>
            Effect.gen(function* () {
              const currentSession = yield* SessionStore.get(sessionId)
              const running = yield* Ref.get(active)
              const files = yield* Ref.get(touchedFiles)
              return yield* Effect.forEach(
                currentSession.chats.filter((chat) => chat.id !== chatId),
                (chat) =>
                  Effect.succeed({
                    chatId: chat.id,
                    title: chat.title ?? "Untitled agent",
                    status: running.has(chat.id) ? "running" as const : "idle" as const,
                    task: chat.title,
                    planStage: null,
                    touchedFiles: [...(files.get(chat.id) ?? [])],
                    updatedAt: chat.updatedAt
                  })
              )
            }).pipe(
              Effect.provide(env),
              Effect.orElseSucceed(() => [] as ReadonlyArray<AgentRosterEntry>)
            )

          const messagePeerAgent = (
            targetChatId: string,
            text: string
          ): Effect.Effect<PeerAgentMessageResult> =>
            SessionStore.get(sessionId).pipe(
              Effect.flatMap((currentSession) =>
                routePeerAgentMessage(
                  currentSession.chats,
                  chatId,
                  targetChatId,
                  text,
                  (target, attributedText) =>
                    Ref.get(active).pipe(
                      Effect.flatMap((runs) => {
                        const run = runs.get(target)
                        return run === undefined
                          ? Effect.succeed(false)
                          : run.steer(attributedText, []).pipe(
                              Effect.map((result) => result.status === "accepted")
                            )
                      })
                    )
                )
              ),
              Effect.provide(env),
              Effect.orElseSucceed(() => ({
                status: "unavailable" as const,
                targetChatId
              }))
            )

          const adapterRun = adapter.run(chatId, spec, {
            emit,
            canUseTool,
            askQuestion,
            publishExplanation,
            listPeerAgents,
            messagePeerAgent,
            registerBackgroundStop,
            registerTurnSteer
          })
          const guardedRun = guardWorkspaceBranch(session, worktreePath, adapterRun).pipe(
            // Started commits the selection. Any exit before it (including a
            // Failed event followed by normal return) restores the prior owner.
            Effect.ensuring(SessionStore.rollbackAgentModel(sessionId, chatId).pipe(Effect.ignore))
          )
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
                    // "Stopped." IS the turn's terminal event, so mark it settled
                    // (right after the emit — `emit` drops events once settled).
                    // Otherwise the run's `settled` flag stays false while the
                    // interrupted fiber unwinds, and a queued message sent in that
                    // window is refused with "already running".
                    yield* Ref.set(sawTerminal, true)
                  })
                )
              )
            ),
            // A stop is not a crash — don't report the operator's own interrupt as
            // "the agent run failed" on top of the note we just wrote.
            Effect.catchAllCause((cause) => {
              if (Cause.isInterruptedOnly(cause)) return Effect.void
              const failure = Option.getOrUndefined(Cause.failureOption(cause))
              // A drifted checkout is recoverable, not a crash: emit the branch
              // pair the renderer's recovery banner needs instead of an error line.
              if (failure instanceof BranchDriftError) {
                return emit({
                  _tag: "BranchDrift",
                  sessionId: failure.sessionId,
                  pinnedBranch: failure.pinnedBranch,
                  liveBranch: failure.liveBranch
                })
              }
              return Effect.logError("agent run failed", Cause.pretty(cause)).pipe(
                Effect.andThen(emit({ _tag: "Failed", message: describeRunFailure(cause) }))
              )
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
                  providerId: session?.providerId ?? null,
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
                    message: `The provider produced no output for ${FIRST_EVENT_DEADLINE}. The turn was cancelled — send your message again.`
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
                Effect.onError(() => SessionStore.rollbackAgentModel(sessionId, chatId).pipe(Effect.ignore)),
                Effect.catchAll((error) =>
                  Effect.succeed(
                    Stream.fromIterable<StreamEvent>([
                      error instanceof BranchDriftError
                        ? {
                            _tag: "BranchDrift",
                            sessionId: error.sessionId,
                            pinnedBranch: error.pinnedBranch,
                            liveBranch: error.liveBranch
                          }
                        : {
                            _tag: "Failed",
                            message:
                              error instanceof AgentRunError
                                ? error.message
                                : "The agent run could not start."
                          }
                    ])
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
        yield* drop(touchedFiles)
      })

    /**
     * Whether this chat has a live, UNSETTLED turn right now — the same
     * staleness rule the single-flight refusal applies (a live fiber whose
     * turn already emitted its terminal event holds nothing worth protecting).
     *
     * Exists for the renderer's reload path: a fresh renderer that dequeued a
     * held message straight into Agent.run while main's previous turn was
     * still streaming got only the refusal text as its "reply", and the
     * message was consumed. Asking first lets the reload hold the queue until
     * the live turn settles.
     */
    const chatBusy = (chatId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const running = (yield* Ref.get(fibers)).get(chatId)
        if (running === undefined) return false
        if (Option.isSome(yield* Fiber.poll(running.fiber))) return false
        return !(yield* Ref.get(running.settled))
      })

    const plannotatorRecoveryNeeded = (
      sessionId: string,
      chatId: string
    ) =>
      Effect.gen(function* () {
        const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
        const chat = session?.chats.find((candidate) => candidate.id === chatId)
        if (chat?.continuation?.runtimeId !== "pi") return false
        const continuationId = chat.continuation.id
        const paths = yield* AppPaths
        return yield* Effect.promise(() =>
          plannotatorReviewPending(continuationId, paths.piSessionsDir)
        )
      })

    return {
      /**
       * Whether any session is mid-run. Read by the learning daemon so a
       * background tick never contends for the rate limits the operator is
       * actively waiting on — the runner already owns this map, so exposing it
       * beats a second source of truth that could disagree.
       */
      anyRunning: anySessionRunActive,
      chatBusy,
      plannotatorRecoveryNeeded,
      prompt,
      decideGate,
      answerQuestion,
      setMode,
      setModel,
      steer,
      stop,
      forgetChat
    } as const
  })
}) {}

/** Native runtimes without run-scoped MCP support must not receive browser leases. */
const acquireRuntimeBrowser = (runtimeId: string | undefined, sessionId: string, chatId: string) =>
  runtimeId === "opencode" ? Effect.succeed(null) : Effect.gen(function* () {
    return yield* (yield* BrowserControlMcpService).acquire(sessionId, chatId, `${sessionId}:${chatId}`)
  })

function prepareTurnSpec(
  session: Session,
  priorMessages: ReadonlyArray<Message>,
  sessionId: string,
  chatId: string,
  browserAttachment: BrowserControlMcpAttachment | null,
  chat: Session["chats"][number],
  connectionId: ProviderConnectionId | undefined,
  modelId: ProviderModelId,
  mode: PermissionMode,
  activePlanExecutionId: null,
  digest: ContextDigest | null,
  worktreePath: string,
  promptText: string,
  primer: string | null,
  planPointer: null,
  adhd: string | null,
  ask: string,
  planProtocol: null,
  images: readonly {
    readonly id: string
    readonly name: string
    readonly mediaType: string
    readonly data: string
  }[],
  reasoning:
    | {
        readonly enabled: boolean
        readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined
      }
    | null
    | undefined
) {
  // Operator-configured mcp.json servers are resolved inside the pi
  // runtime per run (`pi-runtime-live`), not here.
  const mcp = { browser: browserAttachment }

  const spec: AgentTurnSpec = {
    sessionId,
    chatId,
    runtimeId: chat.runtimeId ?? "pi",
    endpointId: chat.endpointId ?? session.endpointId ?? piEndpointId(
      session.environmentId ?? "desktop",
      connectionId!
    ),
    ...(connectionId === undefined ? {} : { connectionId }),
    providerId: chat.providerId ?? session.providerId,
    modelId,
    role: mode === "plan" ? "plan" : activePlanExecutionId ? "plan-execution" : "conversation",
    priorMessages,
    continuation: digest === null ? (chat.continuation ?? null) : null,
    seed:
      digest === null && chat.continuation === undefined && priorMessages.length > 0
        ? { reason: "migration", messages: priorMessages }
        : null,
    targetCapabilities: {
      versions: CURRENT_RUNTIME_CONTRACTS,
      toolIds: [],
      resourceIds: [],
      targetId: session.environmentId ?? "desktop"
    },
    cwd: worktreePath,
    // A slash command is only expanded by the harness when it is the FIRST
    // thing in the message. Prefixing a compaction primer or a plan pointer
    // turned `/babysit-pr …` into prose, and the turn came back instantly
    // with nothing to say — the empty "CLAUDE" block. When the operator
    // opens with a command, the context rides along AFTER it instead.
    prompt:
      promptText.trim() === "/plannotator-resume-review"
        ? "/plannotator-resume-review"
        : composeTurnPrompt(
            promptText,
            {
              primer,
              planPointer,
              adhd,
              tools: managedToolsNote(),
              research: researchFirstNote(),
              ask,
              planProtocol
            },
            { leadWithText: leadsWithCommand(promptText) }
          ),
    images,
    mode,
    reasoning: reasoning ?? chat.reasoning ?? null,
    mcp
  }
  return spec
}

/**
 * The operator-facing line for a turn that ended in an error the run did not
 * classify. A bare "The agent run failed." hides the one thing that would let
 * anyone fix it, so carry the underlying message — whether it arrived as a
 * typed failure or as a defect thrown from setup.
 */
const describeRunFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause))
  if (failure instanceof AgentRunError) return failure.message
  const detail = failureDetail(failure) ?? failureDetail(Option.getOrUndefined(Cause.dieOption(cause)))
  return detail ? `The agent run failed: ${detail}` : "The agent run failed."
}

const failureDetail = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === "string") return value
  if (typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message
  }
  return null
}

const selectedTurnChat = (session: Session | null, chatId: string) =>
  session?.chats.find((candidate) => candidate.id === chatId) ??
  (chatId === session?.id
    ? (session.chats.find((candidate) => candidate.id === session.activeChatId) ?? null)
    : null)

const resolveTurnChat = (sessionId: string, chatId: string) =>
  Effect.gen(function* () {
    const session: Session | null = yield* SessionStore.get(sessionId).pipe(
      Effect.orElseSucceed(() => null)
    )
    const chat = selectedTurnChat(session, chatId)
    if (session === null || chat === null) {
      return yield* Effect.fail(
        new AgentRunError({
          kind: "chat",
          message: "The selected chat no longer exists."
        })
      )
    }
    const runtimeId = chat.runtimeId ?? session.runtimeId ?? "pi"
    const connectionId = chat.connectionId ?? session.connectionId
    const endpointId = chat.endpointId ?? session.endpointId ?? (
      runtimeId === "pi" && connectionId !== undefined
        ? piEndpointId(session.environmentId ?? "desktop", connectionId)
        : undefined
    )
    if (
      chat.modelId === undefined ||
      endpointId === undefined ||
      (runtimeId === "pi" && connectionId === undefined)
    ) {
      return yield* Effect.fail(
        new AgentRunError({
          kind: session.providerId ?? runtimeId,
          message: "Choose an available agent endpoint and model before continuing."
        })
      )
    }
    return {
      session,
      chat: { ...chat, runtimeId, endpointId },
      connectionId,
      modelId: chat.modelId
    }
  })

const resolveTurnWorktree = (sessionId: string, session: Session) =>
  Effect.gen(function* () {
    const storedWorktree = session?.worktreePath ?? ""
    const healPaths = yield* AppPaths
    const worktreePath =
      workspaceModeOf(session) === "direct"
        ? storedWorktree
        : yield* healedWorktreePath(storedWorktree, session.repo, healPaths.worktreesDir)
    if (worktreePath !== storedWorktree) {
      yield* SessionStore.setWorktreePath(sessionId, worktreePath).pipe(Effect.ignore)
    }
    // Re-point the worktree at its repo if the repo directory has moved
    // since the worktree was forked. A worktree's link to its repo is an
    // ABSOLUTE path, so renaming the repo leaves the directory intact but
    // every git command inside it failing — the agent would run, edit
    // files, and only fail at diff/commit time with "not a git
    // repository". Memoised per worktree, so this is one `rev-parse` on
    // the first turn and nothing after.
    if (worktreePath.length > 0 && session?.repoPath && workspaceModeOf(session) === "worktree") {
      yield* ensureWorktreeLinked(session.repoPath, worktreePath)
    }
    // A direct session shares the repository's primary checkout with the
    // developer. Refuse every turn after that checkout moves: continuing
    // would run the agent on a branch different from the one recorded in
    // the session, while plans and review state still name the old branch.
    if (workspaceModeOf(session) === "direct") {
      const liveBranch = yield* branchAt(worktreePath)
      if (liveBranch !== session.branch) {
        return yield* Effect.fail(
          new BranchDriftError({
            sessionId: session.id,
            pinnedBranch: session.branch,
            liveBranch
          })
        )
      }
    }
    return worktreePath
  })

const persistTurnSessionId = (
  sessionId: string,
  chatId: string,
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  event: StreamEvent
) =>
  Effect.gen(function* () {
    if (event._tag === "Started") {
      yield* SessionStore.confirmAgentModel(sessionId, chatId).pipe(Effect.ignore)
      if (event.sessionId.length === 0) return
      yield* SessionStore.setContinuation(sessionId, chatId, {
        runtimeId,
        endpointId,
        id: event.sessionId
      }).pipe(Effect.ignore)
    }
  })

const rememberTurnFile = (
  touchedFiles: Ref.Ref<Map<string, ReadonlyArray<string>>>,
  chatId: string,
  worktreePath: string,
  event: StreamEvent
) =>
  Effect.gen(function* () {
    if (event._tag === "ToolStart" && isFileMutationTool(event.name) && event.target) {
      const path = normalizePath(event.target).replace(
        `${normalizePath(worktreePath).replace(/\/$/, "")}/`,
        ""
      )
      yield* Ref.update(touchedFiles, (current) => {
        const paths = current.get(chatId) ?? []
        return paths.includes(path)
          ? current
          : new Map(current).set(chatId, [...paths, path].slice(-20))
      })
    }
  })

const observeTurnContext = (chatId: string, event: StreamEvent) =>
  Effect.gen(function* () {
    if (event._tag === "Usage") {
      yield* ContextManager.observe(chatId, event.tokens, event.window ?? null).pipe(Effect.ignore)
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
    if (event._tag === "Failed" && isContextOverflowFailure(event.message)) {
      yield* ContextManager.compactNow(chatId, {
        waitForReady: true
      }).pipe(Effect.ignore)
    }
  })

const settleCompletedTurn = (chatId: string, event: StreamEvent) =>
  event._tag === "Done" ? ContextManager.settle(chatId).pipe(Effect.ignore) : Effect.void

interface ActiveTurnSteering {
  readonly turnSteer: Ref.Ref<SteerTurn | null>
  readonly steeredReply: Ref.Ref<RunReplyWaiter | null>
  readonly acc: Ref.Ref<Message>
  /** Cleared here so a pending coalesced flush cannot overwrite the new placeholder. */
  readonly transcriptDirty: Ref.Ref<boolean>
  readonly nextId: Effect.Effect<number>
  readonly chatId: string
  readonly providerId: Session["chats"][number]["providerId"]
}

const steerActiveTurn = (
  state: ActiveTurnSteering,
  text: string,
  images: ReadonlyArray<Attachment>,
  captureReply: boolean
) => {
  const { turnSteer, steeredReply, acc, transcriptDirty, nextId, chatId, providerId } = state
  return Effect.gen(function* () {
    const handler = yield* Ref.get(turnSteer)
    if (handler === null) {
      // No handle is a PHASE, not a verdict: the driver registers it a
      // beat into the run (on `Started`) and retracts it at teardown,
      // and some runs — plan execution — never have a channel at all.
      // `deferred` keeps the message queued for the next boundary or
      // the turn's end; escalating here would let an early "Send now"
      // stop a run that was about to become steerable.
      return { status: "deferred" } as const
    }
    const replyWaiter: RunReplyWaiter | null = captureReply ? yield* makeSteeredReplyWaiter : null
    if (replyWaiter !== null) {
      yield* Ref.set(steeredReply, replyWaiter)
    }
    const steered = yield* invokeSteer(handler, text, images)
    // `unsupported` passes through: the handler is saying this message
    // can NEVER land on this run's channel (pi steering is text-only),
    // and only that status licenses "Send now" to stop and replay.
    // Timeouts and failures stay `deferred` — they may clear.
    const outcome = steered === "accepted" || steered === "unsupported" ? steered : "deferred"
    if (outcome !== "accepted") {
      if (replyWaiter !== null) yield* Ref.set(steeredReply, null)
      return { status: outcome } as const
    }

    const at = yield* Effect.sync(() => new Date().toISOString())
    const settled = settleStreaming(yield* Ref.get(acc))
    const user = userMessage(`u_${chatId}_${yield* nextId}`, text, at, images)
    const assistant = assistantMessage(`a_${chatId}_${yield* nextId}`, at, providerId)
    yield* Ref.set(acc, assistant)
    // This write supersedes any coalesced flush still pending for the
    // old turn; clearing the flag stops that flush from rewriting the
    // new placeholder with a byte-identical copy of itself.
    yield* Ref.set(transcriptDirty, false)
    yield* TranscriptStore.patchLast(chatId, () => settled).pipe(Effect.ignore)
    yield* TranscriptStore.append(chatId, user)
    yield* TranscriptStore.append(chatId, assistant)
    return {
      status: "accepted",
      user,
      assistant,
      replyWaiter
    } as const
  })
}

const prepareTurnDigest = (session: Session, chatId: string) =>
  Effect.gen(function* () {
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
          : (session?.contextTokens ?? 0)
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
    const planPointer = null
    const primer = digest === null ? null : renderPrimer(digest, tail)
    return { digest, compactedFrom, primer, planPointer }
  })

const appendTurnAssistantReply = (
  steeredReply: Ref.Ref<RunReplyWaiter | null>,
  event: StreamEvent
) =>
  Effect.gen(function* () {
    if (event._tag === "Assistant") {
      const waiter = yield* Ref.get(steeredReply)
      if (waiter !== null) {
        yield* appendSteeredReply(waiter, event.text)
      }
    }
  })

const accountTurnUsage = (sessionId: string, event: StreamEvent) =>
  Effect.gen(function* () {
    if (event._tag === "Done") {
      yield* SessionStore.addUsage(sessionId, {
        costUsd: event.costUsd,
        tokens: event.tokens
      }).pipe(Effect.ignore)
    }
  })

const claimTurnTerminal = (
  event: StreamEvent,
  sawTerminal: Ref.Ref<boolean>,
  turnSettled: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    if (!isTerminal(event)) return true
    if (yield* Ref.get(sawTerminal)) return false
    yield* Ref.set(sawTerminal, true)
    yield* Deferred.succeed(turnSettled, void 0)
    return true
  })

const guardWorkspaceBranch = <A, E, R>(
  session: Session,
  worktreePath: string,
  adapterRun: Effect.Effect<A, E, R>
) =>
  session !== null && workspaceModeOf(session) === "direct"
    ? Effect.raceFirst(
        adapterRun,
        Effect.forever(
          Effect.sleep("250 millis").pipe(
            Effect.zipRight(
              Effect.gen(function* () {
                const liveBranch = yield* branchAt(worktreePath)
                if (liveBranch === session.branch) return
                return yield* Effect.fail(
                  new BranchDriftError({
                    sessionId: session.id,
                    pinnedBranch: session.branch,
                    liveBranch
                  })
                )
              })
            )
          )
        )
      )
    : adapterRun

const acknowledgeExternalInstruction = (
  out: Mailbox.Mailbox<StreamEvent>,
  externalInstruction: ExternalInstructionIdentity | undefined
) =>
  Effect.gen(function* () {
    if (externalInstruction !== undefined) {
      yield* out.offer({
        _tag: "ExternalInstructionAccepted",
        identity: externalInstruction,
        duplicate: false
      })
    }
  })

const clearCompactedSessionId = (sessionId: string, chatId: string, digest: ContextDigest | null) =>
  Effect.gen(function* () {
    if (digest !== null) yield* SessionStore.clearContinuation(sessionId, chatId).pipe(Effect.ignore)
  })

const emitCompactedContext = (
  emit: (event: StreamEvent) => Effect.Effect<void>,
  digest: ContextDigest | null,
  tokensBefore: number
) =>
  Effect.gen(function* () {
    if (digest !== null) yield* emit({ _tag: "ContextCompacted", digest, tokensBefore })
  })

const ingestBackgroundTurnEvent = (
  sessionId: string,
  chatId: string,
  event: StreamEvent,
  route: ReturnType<typeof routeOf>
) =>
  Effect.gen(function* () {
    if (route === "background-task")
      yield* BackgroundTaskStore.ingest(sessionId, chatId, event).pipe(Effect.ignore)
  })
