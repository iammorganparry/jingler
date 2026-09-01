import type {
  Attachment,
  AgentRosterEntry,
  ExplanationPayload,
  PeerAgentMessageResult,
  PiRunSpec,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent
} from "@jingler/core"
import type { AgentRunError } from "@jingler/core"
import { Context, Effect, Layer } from "effect"
import type { RuntimeRemoteMcpServer } from "./runtime/mcp/attachment.js"
import type { JinglerMcpAttachments } from "./runtime/tools/mcp-tools.js"
import { isE2eEnv } from "./runtime/e2e-environment.js"

/**
 * A remote MCP attachment ready for an embedded pi run.
 *
 * Main-process only: headers may contain bearer credentials. AgentRunner builds
 * this source-neutral shape immediately before a run; adapters consume it
 * in-memory and never persist or expose it through RPC.
 */
export type RemoteMcpServer = RuntimeRemoteMcpServer

/** Canonical parameters for one turn through the embedded pi runtime. */
export interface AgentTurnSpec extends Omit<PiRunSpec, "runId"> {
  /** Images the operator attached as context for this turn (empty when none). */
  readonly images: ReadonlyArray<Attachment>
  /** Secret-bearing, main-process-only capabilities; never persisted or sent over RPC. */
  /** Run-scoped Jingler MCP capabilities, kept distinct so source risk cannot drift. */
  readonly mcp?: JinglerMcpAttachments
  /** Distinguishes disabled memory from an attempted attachment that failed open. */
  readonly memoryAttachmentStatus?: "disabled" | "available" | "failed"
}

/** What the agent is asking permission to do, surfaced before it acts. */
export interface PermissionRequest {
  readonly kind: "command" | "edit"
  /** Tool name, e.g. "Edit" or "Bash". */
  readonly tool: string
  readonly target: string | null
  /** The shell command awaiting approval, when `kind === "command"`. */
  readonly command: string | null
}

export type PermissionDecision = "allow" | "deny"

/**
 * A permission resolver the runtime calls before any gated action. The
 * `AgentRunner` applies the session's HITL mode/allowlist and, when it must
 * pause, emits an approval gate and awaits the operator.
 */
export type CanUseTool = (req: PermissionRequest) => Effect.Effect<PermissionDecision>

/**
 * Present a group of structured questions to the user and await the answers
 * (mirrors the SDK's AskUserQuestion tool). The `AgentRunner` supplies one that
 * emits a `QuestionRequested` event and parks until the user submits.
 */
export type AskQuestion = (
  request: QuestionRequest
) => Effect.Effect<ReadonlyArray<QuestionAnswer>>

/**
 * What the adapter is handed for a run: an ordered `emit` sink for normalized
 * events, the `canUseTool` gate, `askQuestion` for structured input, and
 * `proposePlan` for plan-mode review. Because the adapter drives a single fiber
 * that interleaves these in program order, the transcript order (where a
 * gate/question/plan lands) is deterministic.
 */
/**
 * Stop ONE background task by its harness task id.
 *
 * Per-run rather than a method on the adapter because the handle only exists
 * while the harness process is alive — a background task cannot outlive the
 * process that owns it, so a stale handle would be worse than none.
 */
export type StopBackgroundTask = (taskId: string) => Promise<void>

/**
 * `deferred` is a phase — the channel exists but cannot take the message right
 * now, so the queue retries at the next boundary. `unsupported` will not clear
 * within this run (e.g. the runtime cannot take images mid-turn), which is what
 * licenses the renderer's "Send now" to stop the turn and replay the message as
 * a fresh one — the only delivery that can still honour "now".
 */
export type TurnSteerResult = "accepted" | "deferred" | "unsupported"
export type SteerTurn = (
  text: string,
  images: ReadonlyArray<Attachment>
) => Promise<TurnSteerResult>

export interface AgentContext {
  readonly emit: (event: StreamEvent) => Effect.Effect<void>
  readonly canUseTool: CanUseTool
  readonly askQuestion: AskQuestion
  /** Publish a durable visual explanation for the current session. */
  readonly publishExplanation?: (explanation: ExplanationPayload) => Effect.Effect<void, Error>
  /**
   * Publish a handle the operator's "Stop" button can reach. Adapters whose
   * harness has no per-task cancellation (codex, opencode — both can only abort
   * a whole turn) simply never call this, and the UI reports the capability as
   * unsupported rather than offering a button that does nothing.
   */
  readonly registerBackgroundStop: (stop: StopBackgroundTask) => Effect.Effect<void>
  readonly listPeerAgents?: () => Effect.Effect<ReadonlyArray<AgentRosterEntry>>
  readonly messagePeerAgent?: (
    targetChatId: string,
    text: string
  ) => Effect.Effect<PeerAgentMessageResult>
  /**
   * Publish Codex's live `turn/steer` handle. Passing null marks phases such as
   * native compaction where direct input is temporarily unavailable.
   */
  readonly registerTurnSteer?: (steer: SteerTurn | null) => Effect.Effect<void>
}

/**
 * Transitional orchestration seam around `AgentRuntime`. Production delegates
 * to embedded pi; deterministic tests supply a scripted driver that emits the
 * same normalized `StreamEvent` contract and permission requests.
 */
export interface AgentTurnDriverShape {
  readonly run: (
    sessionId: string,
    spec: AgentTurnSpec,
    ctx: AgentContext
  ) => Effect.Effect<void, AgentRunError>
  readonly stop: (sessionId: string) => Effect.Effect<void, AgentRunError>
}

export class AgentTurnDriver extends Context.Tag("@jingler/AgentTurnDriver")<
  AgentTurnDriver,
  AgentTurnDriverShape
>() {}

/**
 * The scripted run body — a deterministic sequence (thinking, reads, a gated
 * edit, a gated shell command) driving the full contract without a real process.
 * Reused by `makeScriptedAgentTurnDriver` in deterministic tests and Electron
 * e2e. `delayMs` paces the stream.
 *
 * Markers in the prompt drive the interactive flows: `[[ask]]` → AskUserQuestion,
 * `[[queue-hold]]` parks a test turn so queue affordances can be exercised
 * without borrowing the plan-approval lifecycle.
 * `[[memory-propose]]` publishes the fixed shared-memory E2E fixture, but only
 * when the built Electron suite explicitly sets `JINGLER_E2E=1`.
 * `[[memory-propose-conflict]]` submits a stale accepted-page revision through
 * the same E2E-only path so the harness-facing conflict remains observable.
 */
const SCRIPTED_MEMORY_PROTOCOL = "2026-07-28"
const SCRIPTED_MEMORY_PROPOSE_MARKER = "[[memory-propose]]"
const SCRIPTED_MEMORY_CONFLICT_MARKER = "[[memory-propose-conflict]]"
const SCRIPTED_MEMORY_MARKDOWN = [
  "# Refund rate limiting",
  "",
  "Refund retries share one team limiter so bursts cannot multiply across workers."
].join("\n")

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const callScriptedMemoryTool = async (
  server: RemoteMcpServer,
  id: string,
  name: "memory_navigation" | "memory_propose" | "memory_workflow_status",
  args: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown> | null> => {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      "mcp-protocol-version": SCRIPTED_MEMORY_PROTOCOL
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    })
  })
  const payload: unknown = await response.json()
  if (!isJsonRecord(payload)) return null
  const result = payload.result
  if (!isJsonRecord(result)) return null
  const structuredContent = result.structuredContent
  if (!isJsonRecord(structuredContent)) return null
  const data = structuredContent.data
  return isJsonRecord(data) ? data : null
}

const scriptedMemoryConflictText = (
  data: Readonly<Record<string, unknown>> | null
): string | null => {
  if (data?.status !== "conflict" || !Array.isArray(data.conflicts)) return null
  const conflict = data.conflicts.find(isJsonRecord)
  if (conflict === undefined) return "Memory proposal conflicted."
  const pageId = typeof conflict.pageId === "string" ? conflict.pageId : "unknown page"
  const expected = typeof conflict.expectedBaseRevisionId === "string"
    ? conflict.expectedBaseRevisionId
    : "unknown base"
  const current = typeof conflict.currentHeadRevisionId === "string"
    ? conflict.currentHeadRevisionId
    : "unknown head"
  return `Memory proposal conflict for ${pageId}: expected ${expected}; current ${current}.`
}

export const scriptedRun =
  (delayMs: number): AgentTurnDriverShape["run"] =>
  (sessionId, spec, { emit, canUseTool, askQuestion, registerBackgroundStop, registerTurnSteer }) =>
    Effect.gen(function* () {
      const pause = delayMs > 0 ? Effect.sleep(`${delayMs} millis`) : Effect.void

      // A context-digest run. The scripted adapter exists to drive the FULL
      // contract without a real process, and summarising a session is now part
      // of that contract — without this branch the e2e suite could reach
      // compaction but never complete one, because `parseDigest` would reject
      // the generic scripted reply and the session would silently not compact.
      //
      // Keyed on a phrase from `digestPrompt` rather than a `[[marker]]`: the
      // digest prompt is generated by Jingler, not typed by a user, so there is
      // nowhere to put a marker that a real harness wouldn't also receive.
      if (spec.prompt.includes("You are compacting a coding session's context")) {
        yield* emit({ _tag: "Started", sessionId })
        const digestReply = `\`\`\`json
{
  "goal": "Add rate limiting to the refund endpoint",
  "decisions": ["Reused the token bucket in lib/ratelimit.ts rather than adding a dependency"],
  "filesTouched": ["src/routes/billing.ts"],
  "openThreads": ["The 429 test still needs writing"],
  "preferences": ["Prefers Effect over raw async"]
}
\`\`\``
        // Stream the reply as many small deltas, NOT one blob. A real harness
        // emits assistant text token by token (`text_delta`), so a faithful
        // scripted digest must too — otherwise the e2e path never exercises how
        // the manager REASSEMBLES those fragments. Fixed-size chunks guarantee a
        // boundary lands mid-string, which is exactly the shape that regressed:
        // reassembling with "\n" instead of "" put a raw newline inside a JSON
        // string and made every real digest fail to parse. Chunking the whole
        // string keeps this true even if the reply above is later edited.
        for (let i = 0; i < digestReply.length; i += 17) {
          yield* emit({ _tag: "Assistant", text: digestReply.slice(i, i + 17) })
        }
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      yield* emit({ _tag: "Started", sessionId })
      yield* pause

      // Exercise native MCP wiring in the deterministic adapter too. This is
      // deliberately a standard, header-free MCP call through the attachment
      // URL: it proves the harness-facing loopback proxy works end to end while
      // keeping the upstream organization grant in Jingler's main process.
      const memoryServer = spec.mcp?.memory
      if (memoryServer && "url" in memoryServer) {
        yield* Effect.tryPromise({
          try: () =>
            callScriptedMemoryTool(
              memoryServer,
              `scripted-memory-${sessionId}`,
              "memory_navigation",
              {}
            ),
          catch: () => null
        }).pipe(Effect.ignore)

        // An E2E-only proposal marker lets Electron prove the same
        // agent-owned publication path a real harness uses after its silent
        // end-of-turn reflection. Scripted mode alone is NOT a safe boundary:
        // it is also the production fallback when no supported CLI is installed.
        const memoryConflict = spec.prompt.includes(SCRIPTED_MEMORY_CONFLICT_MARKER)
        const memoryProposal = spec.prompt.includes(SCRIPTED_MEMORY_PROPOSE_MARKER)
        if (isE2eEnv() && (memoryProposal || memoryConflict)) {
          const proposalData = yield* Effect.tryPromise({
            try: () => callScriptedMemoryTool(
              memoryServer,
              `scripted-memory-propose-${sessionId}`,
              "memory_propose",
              memoryConflict
                ? {
                    pageId: "alpha",
                    baseRevisionId: "revision:alpha:1",
                    markdown: "# Alpha memory\n\nA stale update must never overwrite revision two."
                  }
                : {
                    pageId: "shared-learning",
                    baseRevisionId: "new",
                    markdown: SCRIPTED_MEMORY_MARKDOWN
                  }
            ),
            catch: () => null
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))

          const conflictText = scriptedMemoryConflictText(proposalData)
          if (conflictText !== null) yield* emit({ _tag: "Assistant", text: conflictText })

          const workflowId = typeof proposalData?.workflowId === "string"
            ? proposalData.workflowId
            : null
          if (workflowId !== null) {
            yield* Effect.tryPromise({
              try: () => callScriptedMemoryTool(
                memoryServer,
                `scripted-memory-workflow-${sessionId}`,
                "memory_workflow_status",
                { workflowId }
              ),
              catch: () => null
            }).pipe(Effect.ignore)
          }
        }
      }

      // A deterministic busy window for queue E2E. Plan approval used to stand
      // in for this, but messages sent against a proposed plan are now revision
      // feedback by design and must never be treated as an ordinary work queue.
      if (spec.prompt.includes("[[queue-hold]]")) {
        yield* emit({ _tag: "Assistant", text: "Holding the active turn for queue actions." })
        yield* Effect.never
        return
      }

      // A `[[background]]` marker starts a background task that keeps running
      // after the turn ends — the case the dock exists for, and the only way to
      // drive it end-to-end without a real harness. The registered stop handle
      // settles it the way a real one does: by reporting the outcome back through
      // the same signals, rather than mutating state behind the registry's back.
      // A `[[background-agent]]` marker drives the ONE case that used to show the
      // same work twice: a sub-agent that opens a tab at tool_use time and is only
      // then revealed to be backgrounded. The tab must be retracted and the dock
      // row must be the only trace of it.
      if (spec.prompt.includes("[[background-agent]]")) {
        const taskId = `bgagent_${sessionId}`
        const toolUseId = `toolu_${sessionId}`
        yield* emit({
          _tag: "SubagentStarted",
          id: toolUseId,
          name: "Explore",
          description: "Survey the codebase",
          parentId: null
        })
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Surveying the codebase",
          taskType: "subagent",
          subagentType: "Explore",
          toolUseId
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({ _tag: "Assistant", text: "Delegated the survey to a background agent." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      /**
       * A turn HELD OPEN by sub-agents that are still working.
       *
       * The shape the live agent runtime has: the
       * main agent stops talking, but its `Done` is WITHHELD because the sub-agents
       * it delegated to are still running inside the same query. The regression this
       * drives is the one the operator reported — talking to the main agent killed
       * every sub-agent, because settling the turn closed the query all of them ran
       * in and the runner then reaped the process.
       *
       * The steer handle is registered for the whole held window, exactly as the
       * real adapter's is, so a message sent mid-flight lands in THIS turn instead
       * of stopping it and starting another.
       */
      if (spec.prompt.includes("[[held-subagents]]")) {
        const first = `toolu_a_${sessionId}`
        const second = `toolu_b_${sessionId}`
        // The steered text, handed to the event loop below rather than emitted here.
        //
        // A steer handler MUST NOT call `emit`: the runner serializes both behind one
        // semaphore (`agent-runner.ts`, `turnMutation`), so emitting while the steer
        // holds the permit deadlocks — the message hangs on "Sending" and the reply
        // never renders. The real adapters don't either; they hand the harness the
        // text and its answer comes back through the stream a beat later. This models
        // that: the handle only accepts, and the window emits the acknowledgement.
        let pendingSteer: string | null = null
        let steered = false
        if (registerTurnSteer !== undefined) {
          yield* registerTurnSteer((text) => {
            pendingSteer = text
            return Promise.resolve("accepted" as const)
          })
        }
        for (const [id, description] of [[first, "Survey the tab bar"], [second, "Audit the theme tokens"]] as const) {
          yield* emit({ _tag: "SubagentStarted", id, name: "Explore", description, parentId: null })
        }
        yield* emit({ _tag: "Assistant", text: "Delegated to two agents." })
        // The main agent's `result` lands about here. Nothing terminal is emitted:
        // the sub-agents are still working, so the turn is not over.
        //
        // The held window is then paced by REPEATED tool boundaries rather than one.
        // The renderer's steer queue flushes only on a `ToolEnd`
        // (`conversation-machine.ts`, `canAutoFlush`), so a single boundary makes the
        // e2e a race: the spec has to see four elements, fill the composer and land
        // its Enter inside one 300ms gap, and on a slow machine the message queues
        // just AFTER the only boundary, replays as a fresh turn after `Done`, and the
        // steer never renders. A boundary every 300ms across the window means a steer
        // sent at any point in it is flushed by the next one.
        //
        // The window's LENGTH is the other half of that race. Eight ticks is 2.4s, and
        // the spec has to see four elements and type before it runs out — which it does
        // not reliably do on a loaded machine, so the turn settles first and the message
        // replays as a fresh turn. So the window runs until the steer has been seen AND
        // two more boundaries have flushed it, with a hard cap so a run that never
        // steers (the `stop` spec below) still terminates.
        const MIN_TICKS = 8
        const MAX_TICKS = 60 // 18s — past any Playwright assertion in the window
        let ticksAfterSteer = 0
        for (let tick = 0; tick < MAX_TICKS; tick++) {
          if (pendingSteer !== null) {
            yield* emit({ _tag: "Assistant", text: `Noted: ${pendingSteer}` })
            pendingSteer = null
            steered = true
          }
          if (steered) ticksAfterSteer++
          if (tick >= MIN_TICKS && ticksAfterSteer >= 2) break
          yield* Effect.sleep("300 millis")
          yield* emit({ _tag: "Assistant", text: "reading the tab bar", agentId: first })
          yield* emit({
            _tag: "ToolStart",
            id: `read_${sessionId}_${tick}`,
            name: "Read",
            target: "tabs.tsx",
            agentId: first
          })
          yield* emit({
            _tag: "ToolEnd",
            id: `read_${sessionId}_${tick}`,
            status: "success",
            meta: null,
            diff: null,
            preview: null,
            agentId: first
          })
        }
        // One last boundary-free tail, so the steer is demonstrably flushed by a
        // sub-agent's own work rather than by the turn settling.
        yield* Effect.sleep("300 millis")
        yield* emit({ _tag: "SubagentEnded", id: first, status: "done" })
        yield* emit({ _tag: "SubagentEnded", id: second, status: "done" })
        // Only now is the turn genuinely finished.
        yield* emit({ _tag: "Assistant", text: "Both agents reported back." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        if (registerTurnSteer !== undefined) yield* registerTurnSteer(null)
        return
      }

      /**
       * A harness that is STILL ALIVE after the turn it just ended.
       *
       * This is what the real Claude adapter does and the plain `[[background]]`
       * marker does not: its `for await` over the SDK never breaks on `result`, so
       * `run` keeps consuming — that is how a backgrounded task's
       * `task_notification` bookend arrives after `Done`. The scripted harness
       * returning immediately made that whole window untestable, and the window is
       * exactly where the chat's run reservation is still held while the renderer,
       * which went idle on `Done`, shows a send button.
       */
      if (spec.prompt.includes("[[background-live-harness]]")) {
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: `bglive_${sessionId}`,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [`bglive_${sessionId}`] })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        // Deliberately no `return`: the turn has settled but the harness has not
        // exited, which is the real adapter's shape.
        yield* Effect.sleep("60 seconds")
        return
      }

      /**
       * A background task that FINISHES on its own, after its turn is over.
       *
       * The bookend is the whole point: a real harness reports settlement through a
       * later `task_notification`, which only arrives if the process is still
       * consuming — so this is the case that proves the run outlives the turn and
       * the dock learns the outcome without the operator prompting again.
       */
      if (spec.prompt.includes("[[background-completes]]")) {
        const taskId = `bgdone_${sessionId}`
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        // The turn is over. The work is not.
        yield* Effect.sleep("2 seconds")
        yield* emit({
          _tag: "BackgroundTaskSettled",
          id: taskId,
          status: "completed",
          summary: "42 tests passed.",
          outputFile: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [] })
        return
      }

      if (spec.prompt.includes("[[background]]")) {
        const taskId = `bgtask_${sessionId}`
        yield* registerBackgroundStop(async (id) => {
          if (id !== taskId) return
          await Effect.runPromise(
            emit({
              _tag: "BackgroundTaskSettled",
              id: taskId,
              status: "stopped",
              summary: "Stopped by the operator.",
              outputFile: null
            }).pipe(Effect.zipRight(emit({ _tag: "BackgroundTasksChanged", ids: [] })))
          )
        })
        yield* emit({
          _tag: "BackgroundTaskStarted",
          id: taskId,
          description: "Watching the test suite",
          taskType: "bash",
          subagentType: null,
          toolUseId: null
        })
        yield* emit({ _tag: "BackgroundTasksChanged", ids: [taskId] })
        yield* emit({
          _tag: "BackgroundTaskProgress",
          id: taskId,
          description: "Watching the test suite",
          tokens: 1200,
          toolUses: 3,
          durationMs: 12_000,
          lastTool: "Bash"
        })
        yield* emit({ _tag: "Assistant", text: "Started a watcher in the background." })
        // The turn ENDS while the task runs on — exactly the situation that made
        // this work invisible before the dock existed.
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[storm]]` marker emits a run of consecutive tool calls (no text
      // between) so the transcript's collapse-to-latest grouping can be exercised.
      if (spec.prompt.includes("[[storm]]")) {
        yield* emit({ _tag: "Thinking", text: "Scanning the codebase.", seconds: 2, done: true })
        yield* pause
        for (let i = 1; i <= 4; i++) {
          yield* emit({ _tag: "ToolStart", id: `read-${i}`, name: "Read", target: `src/file-${i}.ts` })
          yield* pause
          yield* emit({ _tag: "ToolEnd", id: `read-${i}`, status: "success", meta: `${i * 10} lines`, diff: null, preview: null })
          yield* pause
        }
        yield* emit({ _tag: "Assistant", text: "Scanned four files." })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[ask]]` marker in the prompt drives the AskUserQuestion flow (used by
      // the question e2e/tests) instead of the default gated edit/command flow.
      if (spec.prompt.includes("[[ask]]")) {
        yield* emit({
          _tag: "Thinking",
          text: "Before I start I need a couple of decisions.",
          seconds: 2,
          done: true
        })
        yield* pause
        const answers = yield* askQuestion({
          id: `q_${sessionId}`,
          questions: [
            {
              question: "Which token strategy should the store use?",
              header: "Strategy",
              multiSelect: false,
              options: [
                { label: "Rotating refresh tokens", description: "New refresh token on every use — most secure." },
                { label: "Sliding session", description: "Extend expiry on activity, single long-lived token." },
                { label: "Short-lived access + refresh", description: "15-min access, 7-day refresh. The common default." }
              ]
            },
            {
              question: "Which surfaces should adopt the new store?",
              header: "Surfaces",
              multiSelect: true,
              options: [
                { label: "HTTP middleware", description: "Express session guard on the API." },
                { label: "WebSocket handshake", description: "Auth on the realtime channel." },
                { label: "Background workers", description: "Queue consumers acting on a user's behalf." }
              ]
            }
          ]
        })
        const summary = answers
          .map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(", ") || "—")
          .join(" · ")
        yield* emit({ _tag: "Assistant", text: `Got it — starting with: ${summary}.` })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A `[[codex-edit-preview]]` marker gives the Electron suite a deterministic
      // Codex-labelled update + create pair. The scripted adapter stands in for
      // the harness there; the adapter unit tests separately prove that real
      // Codex fileChange payloads produce this same normalized contract.
      if (spec.prompt.includes("[[codex-edit-preview]]")) {
        yield* emit({ _tag: "ToolStart", id: "codex-edit-1", name: "Edit", target: "src/config.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-edit-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* pause
        yield* emit({ _tag: "ToolStart", id: "codex-create-1", name: "Edit", target: "src/created.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-create-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 0 },
          preview: "+export const created = true"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // One completed mutation for the Files workspace's focused-diff E2E. The
      // fixture changes the real file first; this stream supplies the same tool
      // identity and compact hunk a live harness publishes.
      if (spec.prompt.includes("[[follow-diff-preview]]")) {
        yield* emit({
          _tag: "ToolStart",
          id: "follow-diff-1",
          name: "Edit",
          target: "src/config.ts"
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "follow-diff-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // The fixture performs a real move before this event. Reporting the
      // source path mirrors harnesses that publish the path attached to the
      // original edit tool while the workspace diff carries the destination.
      if (spec.prompt.includes("[[follow-file-move]]")) {
        yield* emit({
          _tag: "ToolStart",
          id: "follow-move-1",
          name: "Edit",
          target: "src/config.ts"
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "follow-move-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 1 },
          preview: "-export const mode = 'legacy'\n+export const mode = 'modern'"
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      if (spec.prompt.includes("[[expect-code-context]]")) {
        yield* emit({
          _tag: "Assistant",
          text: spec.prompt.includes("<repository-code-references>")
            ? "Received selected diff context."
            : "Selected diff context was missing."
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // A nested sub-agent mutation for the Files workspace's opt-in follow
      // coverage. The child is deliberately two levels below the main agent so
      // the Electron test proves follow observes descendants, rather than only
      // the main transcript or direct children.
      if (spec.prompt.includes("[[subagent-edit-preview]]")) {
        const parent = `toolu_parent_${sessionId}`
        const child = `toolu_child_${sessionId}`
        yield* emit({
          _tag: "SubagentStarted",
          id: parent,
          name: "Explore",
          description: "Delegate the file update",
          parentId: null
        })
        yield* emit({
          _tag: "SubagentStarted",
          id: child,
          name: "general-purpose",
          description: "Update the delegated file",
          parentId: parent
        })
        yield* emit({
          _tag: "ToolStart",
          id: "subagent-edit-1",
          name: "Edit",
          target: "src/delegated.ts",
          agentId: child
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "subagent-edit-1",
          status: "success",
          meta: null,
          diff: { added: 1, removed: 0 },
          preview: "+export const delegated = true",
          agentId: child
        })
        yield* emit({ _tag: "SubagentEnded", id: child, status: "done" })
        yield* emit({ _tag: "SubagentEnded", id: parent, status: "done" })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      // Models the older/partial Codex file-change shape that reports a
      // successful Edit without diff metadata. The Electron regression creates
      // this file after the initial workspace listing, then proves the ToolEnd
      // refresh makes the absolute path in the response open the Preview dock.
      if (spec.prompt.includes("[[codex-open-created-file]]")) {
        const relativePath = "reports/codex-created.md"
        const absolutePath = `${spec.cwd}/${relativePath}`
        yield* emit({
          _tag: "ToolStart",
          id: "codex-open-created-1",
          name: "Edit",
          target: absolutePath
        })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "codex-open-created-1",
          status: "success",
          meta: null,
          diff: null,
          preview: null
        })
        yield* emit({
          _tag: "Assistant",
          text: `Created [codex-created.md](${absolutePath}).`
        })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        return
      }

      yield* emit({ _tag: "Thinking", text: "No limiter middleware exists yet. ", seconds: null, done: false })
      yield* pause
      yield* emit({
        _tag: "Thinking",
        text: "I'll reuse the token-bucket in lib/ratelimit.ts, apply it to POST /refund, then add a 429 test.",
        seconds: 6,
        done: true
      })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "read-1", name: "Read", target: "src/routes/billing.ts" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "read-1", status: "success", meta: "142 lines", diff: null, preview: null })
      yield* pause
      yield* emit({ _tag: "ToolStart", id: "grep-1", name: "Grep", target: "rateLimit|tokenBucket" })
      yield* pause
      yield* emit({ _tag: "ToolEnd", id: "grep-1", status: "success", meta: "0 hits", diff: null, preview: null })
      yield* pause
      yield* emit({
        _tag: "Assistant",
        text: "No limiter is wired up. Adding the middleware to the refund route and a matching test."
      })
      yield* pause

      // ── Edit (gated on `kind === "edit"`) ──
      const editDecision = yield* canUseTool({
        kind: "edit",
        tool: "Edit",
        target: "src/routes/billing.ts",
        command: null
      })
      if (editDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/routes/billing.ts" })
        yield* pause
        yield* emit({
          _tag: "ToolEnd",
          id: "edit-1",
          status: "success",
          meta: null,
          diff: { added: 7, removed: 0 },
          preview: "61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"
        })
      } else {
        yield* emit({ _tag: "Assistant", text: "Holding the edit until you approve it." })
      }
      yield* pause

      // ── Shell command (gated on `kind === "command"`) ──
      const cmdDecision = yield* canUseTool({
        kind: "command",
        tool: "Bash",
        target: "npm test -- billing",
        command: "npm test -- billing"
      })
      if (cmdDecision === "allow") {
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "npm test -- billing" })
        yield* pause
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: "1 passed", diff: null, preview: null })
      } else {
        yield* emit({ _tag: "Assistant", text: "Left the tests unrun for now." })
      }
      yield* pause
      yield* emit({ _tag: "Done", costUsd: 0.38, tokens: 42_100 })
    })

/**
 * A deterministic driver for unit tests and Electron e2e. `delayMs` paces the
 * stream while the production driver delegates to embedded pi.
 */
export const makeScriptedAgentTurnDriver = (delayMs: number): Layer.Layer<AgentTurnDriver> =>
  Layer.succeed(AgentTurnDriver, AgentTurnDriver.of({ run: scriptedRun(delayMs), stop: () => Effect.void }))

/** The default scripted adapter, paced for a visible streaming cadence. */
export const ScriptedAgentTurnDriverLive = makeScriptedAgentTurnDriver(320)
