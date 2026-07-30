import type {
  Attachment,
  DiffStat,
  PermissionMode,
  Question,
  QuestionAnswer,
  ReasoningEffort,
  StreamEvent
} from "@jingler/core"
import { CliExecError } from "@jingler/core"
import type {
  McpServerConfig,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"
import { Effect, Runtime } from "effect"
import type {
  AgentContext,
  PermissionRequest,
  RemoteMcpServer,
  SessionSpec
} from "./adapter.js"
import { startTeeStream, type TeeStream } from "./bash-tee.js"
import { escapingPath } from "./confinement.js"
import { unattendedSandbox } from "./sandbox.js"
import { harnessEnv, hasSubscriptionAuth } from "./subscription.js"
import { requireWorktree } from "./cwd.js"
import { worktreeEnv } from "./worktree-env.js"
import { capOutput } from "./output-cap.js"
import { formatQuestionAnswers } from "./question-prompt.js"
import {
  hasPlanBlock,
  parsePlan,
  PLAN_HTML_REFORMAT,
  planModeInstructions
} from "./plan-parse.js"
import { turnContinuation } from "./turn-continuation.js"

/**
 * Real Claude harness, driven by `@anthropic-ai/claude-agent-sdk`'s `query()`.
 * The adapter parses the SDK's message stream into our normalized `StreamEvent`s
 * (via `ctx.emit`) and bridges the SDK's `canUseTool` onto our `CanUseTool`, so
 * the transcript, HITL machine and UI never know which harness ran. The mapping
 * functions are pure and unit-tested against SDK-message fixtures; `runClaude`
 * itself is verified live (needs the user's `claude` login).
 */

// ── Pure mapping helpers (the testable seam) ─────────────────────────────────

const strOf = (v: unknown): string | null => (typeof v === "string" ? v : null)
const numOf = (v: unknown): number => (typeof v === "number" ? v : 0)

/** Tools that write to disk — gated as "edit" and carry a diff peek. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"])
export const isEditTool = (name: string): boolean => EDIT_TOOLS.has(name)

/**
 * Interactive tools surfaced via dedicated UI (the plan card / question card),
 * so their raw tool cards are suppressed from the transcript to avoid a redundant
 * (and confusingly "pending") duplicate.
 */
const SUPPRESSED_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"])

/**
 * How often a running Bash command's tee file is polled for new output. Fast
 * enough to feel live, slow enough that a chatty command doesn't flood the RPC —
 * each poll re-reads the whole file and re-sends only if it grew.
 */
const TEE_POLL_MS = 150

/**
 * How `spec.readOnly` is enforced on this harness: the SDK refuses these outright.
 *
 * Belt to `canUseTool`'s braces — that callback only fires for tool names
 * `toPermissionRequest` maps, so anything unrecognised is allowed ungated. `Task`
 * is included because a subagent is a second lever on the same worktree.
 * Read/Grep/Glob are deliberately absent: a read-only run still needs to read.
 */
const READ_ONLY_DISALLOWED: ReadonlyArray<string> = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "Task",
  "Agent"
]

/**
 * Map our HITL mode onto the SDK's permission mode.
 *
 * "auto" maps to "default", NOT "bypassPermissions" — deliberately. The SDK
 * skips `canUseTool` entirely under "bypassPermissions" (it warns as much:
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), and that callback is not just a permission
 * gate: it's where `ExitPlanMode` and `AskUserQuestion` are intercepted and
 * turned into the plan / question cards. Shadowed, `AskUserQuestion` is
 * auto-approved, runs headlessly and silently skips — the agent's question
 * never reaches the operator.
 *
 * Nothing is lost by dropping it: `verdict()` in `agent-runner.ts` already
 * returns "allow" for every request in "auto", so our own gate keeps the mode
 * ungated. This is the same reasoning the plan-approval path uses when it
 * restores "default" mid-run (see `setPermissionMode` below).
 *
 * "plan" ALSO maps to "default", NOT the SDK's "plan" mode — deliberately. The
 * SDK's plan mode hard-blocks every edit tool BEFORE `canUseTool` runs, so a
 * planning agent that tries to write (e.g. drafting the plan to a file) gets an
 * opaque tool error and derails instead of planning. In Jingler, writes are
 * always enabled in plan mode and gated only by our own `canUseTool` — the plan
 * OUTPUT protocol still comes from `planModeInstructions` (injected on
 * `spec.mode === "plan"`, independent of this permission mode) and `ExitPlanMode`
 * is still intercepted by `canUseTool` in "default" mode.
 */
export const mapPermissionMode = (mode: PermissionMode): SdkPermissionMode =>
  mode === "accept-edits" ? "acceptEdits" : "default"

/** Validate provider-native values for Claude's adaptive-thinking API. */
export const mapClaudeReasoning = (
  effort: ReasoningEffort | undefined,
  enabled: boolean | undefined = true
):
  | Record<never, never>
  | {
      thinking: { type: "disabled" } | { type: "adaptive" }
      effort?: "low" | "high" | "max"
    } => {
  if (!enabled) return { thinking: { type: "disabled" } }
  return effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
    ? { thinking: { type: "adaptive" }, effort }
    : {}
}

/**
 * Handed back when a plan arrives without its ` ```plan ` fence. Jingler renders
 * plans from that block, so a fence-less plan has no steps to review — we ask for
 * one reformat before falling back to showing the raw markdown.
 */
export const PLAN_REFORMAT = `${PLAN_HTML_REFORMAT} You MUST call ExitPlanMode again.`

/**
 * The gate request for a tool the SDK asked about, or null for read-only tools
 * (Read/Grep/Glob/…) which are never gated.
 */
export const toPermissionRequest = (
  toolName: string,
  input: Record<string, unknown>
): PermissionRequest | null => {
  if (isEditTool(toolName)) {
    return {
      kind: "edit",
      tool: toolName,
      target: strOf(input.file_path) ?? strOf(input.path) ?? strOf(input.notebook_path),
      command: null
    }
  }
  if (toolName === "Bash") {
    return { kind: "command", tool: "Bash", target: strOf(input.command), command: strOf(input.command) }
  }
  return null
}

/**
 * Parse the SDK AskUserQuestion dialog payload (`{ questions: [...] }`) into our
 * `Question[]`. Defensive — the payload is transported opaquely, so every field
 * is treated as possibly-absent. Returns [] when there's nothing renderable.
 */
export const parseSdkQuestions = (payload: Record<string, unknown>): ReadonlyArray<Question> => {
  const raw = Array.isArray(payload.questions) ? (payload.questions as Array<Record<string, unknown>>) : []
  return raw
    .map((q): Question => {
      const opts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []
      return {
        question: strOf(q.question) ?? "",
        header: strOf(q.header) ?? "",
        multiSelect: q.multiSelect === true,
        options: opts.map((o) => {
          const preview = strOf(o.preview)
          return {
            label: strOf(o.label) ?? "",
            description: strOf(o.description) ?? "",
            ...(preview ? { preview } : {})
          }
        })
      }
    })
    .filter((q) => q.question.length > 0 && q.options.length > 0)
}

/**
 * Format the operator's answers as the reply the model reads. AskUserQuestion is
 * a permission-gated tool in this SDK (not a dialog), and `canUseTool` can only
 * allow/deny — so the deny `message` is the only channel that carries content
 * back. We phrase the picks as the answer so the model continues with them.
 * Pure + exported for regression coverage of the exact wording.
 */
export const formatQuestionAnswer = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): string => formatQuestionAnswers(questions, answers)

/**
 * Tools that spawn a watch-only sub-agent. Claude Code has surfaced this as
 * `Task` and (in newer builds) `Agent`; treat both as a sub-agent spawn so each
 * gets its own readable tab.
 */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

const toolTarget = (name: string, input: Record<string, unknown>): string | null => {
  if (name === "Bash") return strOf(input.command)
  if (name === "Grep" || name === "Glob") return strOf(input.pattern)
  // A sub-agent spawn's target is its one-line task description.
  if (SUBAGENT_TOOLS.has(name)) return strOf(input.description)
  // Invoking a skill: WHICH skill is the entire content of the card. Without
  // this the input's `skill`/`args` match nothing below, the target comes out
  // null, and the transcript shows a bare "Skill" — the one thing it needed to
  // say, missing.
  if (name === "Skill") {
    const skill = strOf(input.skill)
    if (skill === null) return null
    const args = strOf(input.args)
    return args ? `${skill} ${args}` : skill
  }
  return strOf(input.file_path) ?? strOf(input.path) ?? strOf(input.notebook_path) ?? strOf(input.url)
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split("\n").length)

// ── Diff-hunk preview ────────────────────────────────────────────────────────
// The preview is a unified-diff hunk: each line's FIRST character is the marker
// ("+" added, "-" removed, " " context, "…" a truncation gutter), the rest is the
// code verbatim. Content-independent so a context line that happens to start with
// "+"/"-" is never mis-tinted. `DiffPeek` renders it.

/** Context lines kept either side of a change, so the edit reads in situ. */
const HUNK_CONTEXT = 3
/** Cap the changed region so a huge replace doesn't produce a wall of lines. */
const HUNK_MAX_CHANGED = 40

const mark = (sign: "+" | "-" | " ", line: string): string => `${sign}${line}`

/** Truncate a run of changed lines, appending a "… N more" gutter when clipped. */
const clip = (lines: ReadonlyArray<string>, sign: "+" | "-"): ReadonlyArray<string> => {
  if (lines.length <= HUNK_MAX_CHANGED) return lines.map((l) => mark(sign, l))
  const shown = lines.slice(0, HUNK_MAX_CHANGED).map((l) => mark(sign, l))
  return [...shown, `…${lines.length - HUNK_MAX_CHANGED} more ${sign === "+" ? "added" : "removed"} line(s)`]
}

/**
 * Build a unified-diff hunk from an edit's `old_string`/`new_string` by trimming
 * the common prefix/suffix (the surrounding lines Claude includes to disambiguate
 * the edit) down to `HUNK_CONTEXT` lines of context around the actual change.
 * Returns null when there is no line-level change to show.
 */
const unifiedHunk = (oldS: string, newS: string): string | null => {
  const o = oldS.length === 0 ? [] : oldS.split("\n")
  const n = newS.length === 0 ? [] : newS.split("\n")
  let p = 0
  while (p < o.length && p < n.length && o[p] === n[p]) p++
  let s = 0
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++
  const removed = o.slice(p, o.length - s)
  const added = n.slice(p, n.length - s)
  if (removed.length === 0 && added.length === 0) return null

  const preFrom = Math.max(0, p - HUNK_CONTEXT)
  const postTo = Math.min(o.length, o.length - s + HUNK_CONTEXT)
  const out: Array<string> = []
  if (preFrom > 0) out.push("…")
  for (const c of o.slice(preFrom, p)) out.push(mark(" ", c))
  out.push(...clip(removed, "-"))
  out.push(...clip(added, "+"))
  for (const c of o.slice(o.length - s, postTo)) out.push(mark(" ", c))
  if (postTo < o.length) out.push("…")
  return out.join("\n")
}

/** First N lines of new file content as an added-only hunk (for Write). */
const addedHunk = (content: string): string | null => {
  if (content.length === 0) return null
  const lines = content.split("\n")
  const shown = lines.slice(0, HUNK_MAX_CHANGED).map((l) => mark("+", l))
  if (lines.length > HUNK_MAX_CHANGED) shown.push(`…${lines.length - HUNK_MAX_CHANGED} more line(s)`)
  return shown.join("\n")
}

/** Derive a `DiffStat` + a multi-line diff-hunk preview from an edit tool's input. */
export const editStats = (
  name: string,
  input: Record<string, unknown>
): { diff: DiffStat | null; preview: string | null } => {
  if (name === "Write") {
    const content = strOf(input.content) ?? ""
    return { diff: { added: lineCount(content), removed: 0 }, preview: addedHunk(content) }
  }
  if (name === "Edit" || name === "Update" || name === "NotebookEdit") {
    const oldS = strOf(input.old_string) ?? ""
    const newS = strOf(input.new_string) ?? ""
    return {
      diff: { added: lineCount(newS), removed: lineCount(oldS) },
      preview: unifiedHunk(oldS, newS)
    }
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []
    let added = 0
    let removed = 0
    const hunks: Array<string> = []
    for (const e of edits) {
      const oldS = strOf(e.old_string) ?? ""
      const newS = strOf(e.new_string) ?? ""
      added += lineCount(newS)
      removed += lineCount(oldS)
      const h = unifiedHunk(oldS, newS)
      if (h !== null) hunks.push(h)
    }
    // Separate each edit's hunk with a blank context line so they read as distinct.
    return { diff: { added, removed }, preview: hunks.length > 0 ? hunks.join("\n \n") : null }
  }
  return { diff: null, preview: null }
}

/**
 * Build the SDK `query` prompt for a turn. With no attachments it's the plain
 * text string (unchanged behaviour). With images it becomes the SDK's
 * streaming-input form: a single user message whose content interleaves the text
 * with base64 image blocks — the shape the harness reads images from. Pure +
 * exported so the interleaving is unit-tested without the live SDK.
 */
export const userMessageFor = (
  text: string,
  images: ReadonlyArray<Attachment>,
  resumeId: string | undefined
): SDKUserMessage => {
  // A bare string is the simpler content shape, but only when there are no
  // images — the block list is what carries base64 attachments.
  const content =
    images.length === 0
      ? text
      : [
          ...(text.length > 0 ? [{ type: "text", text }] : []),
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data }
          }))
        ]
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: resumeId ?? ""
  } as SDKUserMessage
}

/** A turn's input channel: the opening prompt, plus anything steered in later. */
export interface LiveInput {
  /** Hand this to `query({ prompt })` — it stays open until `finish()`. */
  readonly iterable: AsyncIterable<SDKUserMessage>
  /**
   * Push a message into the LIVE turn. False means the turn is already closing,
   * in which case the caller must keep the message queued rather than assume it
   * landed — `Agent.steer` reports that as `deferred`.
   */
  readonly push: (text: string, images: ReadonlyArray<Attachment>) => boolean
  /** Whether a pushed message is still sitting unread in the channel. */
  readonly hasUnread: () => boolean
  /**
   * Whether anything was pushed since this was last asked — the question that
   * actually decides whether a turn is over.
   *
   * `hasUnread` is not enough: the SDK pulls a pushed message out within a
   * microtask, so by the time the turn's `result` is handled the channel usually
   * looks empty even though the CLI has not acted on the message yet. Probing the
   * real harness (`scripts/probe-claude-steer.ts --at-result --drain-first`)
   * showed it then answers in a SECOND turn — so treating that result as the end
   * of the run settles the conversation while a reply is still coming, and the
   * operator's steered message sits there with no visible answer.
   */
  readonly takeSteered: () => boolean
  /** Refuse further pushes and end the input, letting the SDK finish the query. */
  readonly finish: () => void
}

/**
 * The prompt as a LIVE channel rather than a fixed value.
 *
 * The SDK's streaming-input form keeps the query open until the input iterable
 * ends, which is the only way to put a message into a turn that is already
 * running — the whole point of Jingler's queue: a correction typed 10 seconds in
 * should reach the agent at the next tool boundary, not two minutes later against
 * work it was meant to redirect. So the adapter opens the channel, yields the
 * prompt, and holds it open until the turn is genuinely over.
 *
 * `finish()` and `push()` are deliberately racy-safe in ONE direction: once
 * finishing, a push is refused. Losing a message would be far worse than
 * deferring it — a refused push stays in the renderer's queue and simply runs as
 * the next turn.
 */
export const makeLiveInput = (
  spec: SessionSpec,
  resumeId: string | undefined
): LiveInput => {
  const pending: Array<SDKUserMessage> = [userMessageFor(spec.prompt, spec.images, resumeId)]
  let done = false
  let steered = false
  // Resolver for the consumer parked on an empty queue, so a push wakes it
  // immediately instead of the generator polling.
  let wake: (() => void) | null = null
  const bump = () => {
    const w = wake
    wake = null
    w?.()
  }

  const iterable = (async function* () {
    for (;;) {
      const next = pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (done) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  })()

  return {
    iterable,
    push: (text, images) => {
      if (done) return false
      if (text.length === 0 && images.length === 0) return false
      pending.push(userMessageFor(text, images, resumeId))
      steered = true
      bump()
      return true
    },
    hasUnread: () => pending.length > 0,
    takeSteered: () => {
      const was = steered
      steered = false
      return was
    },
    finish: () => {
      done = true
      bump()
    }
  }
}

const contentBlocks = (message: unknown): ReadonlyArray<Record<string, unknown>> => {
  const content = (message as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

/** The text a `tool_result` carries, whether it arrived bare or in a block list. */
const toolResultText = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  return strOf(
    (content.find((b) => (b as { type?: unknown }).type === "text") as { text?: unknown } | undefined)?.text
  )
}

const toolResultMeta = (name: string | undefined, content: unknown): string | null => {
  if (name !== "Read") return null
  const text = toolResultText(content)
  return text ? `${lineCount(text)} lines` : null
}

/**
 * Tools whose `tool_result` is an acknowledgement rather than output.
 *
 * A backgrounded Task's result lands ~150ms after the spawn saying only "Async
 * agent launched successfully", while the agent itself runs on for minutes and
 * reports into its own tab. Showing that ACK as the call's "output" would state
 * the opposite of what's happening. (Same reason its tool_result doesn't settle
 * the tab — see the `SUPPRESSED_TOOLS` note and the bookend below.)
 */
const ACK_ONLY_TOOLS = new Set(["Task"])

/**
 * What a tool printed, for the card's expanded body.
 *
 * Edit tools are excluded: their result is a bare confirmation, and the card
 * already shows the real change as a diff peek built from the tool's INPUT — so
 * storing "ok" would cost transcript size on every edit and add nothing.
 */
const toolResultOutput = (name: string | undefined, content: unknown): string | undefined => {
  if (name !== undefined && (isEditTool(name) || ACK_ONLY_TOOLS.has(name))) return undefined
  const text = toolResultText(content)?.trim()
  return text ? capOutput(text) : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * Tokens occupying Claude's context window after the latest sampling iteration.
 *
 * Cached input still occupies context even though it is billed differently. A
 * response can also contain several server-side iterations; their top-level
 * usage is cumulative consumption, while the SDK explicitly defines the final
 * iteration as the source of truth for current context size.
 */
const contextTokens = (usage: unknown): number => {
  const aggregate = isRecord(usage) ? usage : {}
  const iterations = Array.isArray(aggregate.iterations) ? aggregate.iterations : []
  const last = iterations.at(-1)
  const current = isRecord(last) ? last : aggregate
  return sumTokens(current)
}

/**
 * Total tokens BILLED for a run — the result message's cumulative usage.
 *
 * Same arithmetic as `contextTokens`, deliberately a different function: this
 * one is fed a total that has already been summed across every sampling call in
 * the turn, so it answers "what did this cost" and never "how full is the
 * window". Two names because one name was the bug — the result usage was read
 * as an occupancy reading and drove compaction from a number that grows with
 * tool-call count.
 */
const runTokens = (usage: unknown): number => sumTokens(isRecord(usage) ? usage : {})

/** Cached input still occupies the window even though it is billed differently. */
const sumTokens = (usage: Record<string, unknown>): number =>
  numOf(usage.input_tokens) +
  numOf(usage.cache_creation_input_tokens) +
  numOf(usage.cache_read_input_tokens) +
  numOf(usage.output_tokens)

/**
 * How long the end-of-turn context probe may take before we fall back.
 *
 * A control request travels to the CLI child and back, so it can hang exactly
 * when the child is unhealthy — which is also when the turn is trying to end.
 * The fallback (the last per-message reading) is good, so waiting is not worth
 * much: bound it hard and move on.
 */
const CONTEXT_PROBE_MS = 3_000

/**
 * The authoritative end-of-turn context reading, straight from the harness.
 *
 * `getContextUsage()` is the same data the CLI's own context meter renders, so
 * it needs no reconstruction from usage arithmetic and no model-id table to
 * name the ceiling. Everything else here is best-effort around it: an older
 * CLI may not implement the control request at all, and a wedged child may
 * never answer — in both cases `null` sends the caller back to the per-message
 * readings, which is exactly today's behaviour minus the inflation.
 */
export const probeContextUsage = async (
  query: Query
): Promise<{ tokens: number; window: number } | null> => {
  const get = (query as Partial<Query>).getContextUsage
  if (typeof get !== "function") return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const usage = await Promise.race([
      get.call(query),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CONTEXT_PROBE_MS)
      })
    ])
    if (usage === null || !isRecord(usage)) return null
    const tokens = numOf(usage.totalTokens)
    if (tokens <= 0) return null
    // `rawMaxTokens` is the model's real ceiling; `maxTokens` is what the CLI
    // will let itself fill before its OWN autocompact kicks in. Taking the
    // discounted number would stack that reserve on top of the safety margin in
    // `triggerAt`, compacting materially earlier than the budget asks for.
    const window = numOf(usage.rawMaxTokens) || numOf(usage.maxTokens)
    return { tokens, window: window > 0 ? window : 0 }
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Remembers a tool call's name/input between its `tool_use` and `tool_result`. */
export interface ToolMemo {
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * Fold one SDK message into normalized `StreamEvent`s. `tools` correlates a
 * `tool_use` with its later `tool_result` so an edit's diff/preview can be
 * attached at completion. Deterministic given (msg, tools) — unit tested.
 */
/** Task metadata remembered from `task_started`, used if the task is backgrounded. */
interface TaskMemo {
  readonly description: string
  readonly taskType: string
  readonly subagentType: string | null
  readonly toolUseId: string | null
}

/**
 * Per-run background-task bookkeeping, threaded through `streamEventsFor`.
 *
 * `live` mirrors the harness's level signal (the current set). `ever` is every
 * id we have promoted to the dock, and is what settles are keyed on — an id
 * leaves `live` the instant it finishes, often before its bookend arrives.
 * `meta` holds `task_started` details for tasks that may never be backgrounded.
 *
 * Per-run and in-memory by design: the harness's live set is per-process, so
 * carrying it across a restart would strand rows whose ids no longer resolve.
 */
export interface BackgroundTaskState {
  readonly meta: Map<string, TaskMemo>
  readonly live: Set<string>
  readonly ever: Set<string>
  /**
   * `tool_use_id`s this harness has bookended with a `task_started`.
   *
   * The version gate for "will a `task_notification` ever arrive for this Task?".
   * `task_started` fires for FOREGROUND tasks too, so it does not tell us whether
   * a Task was backgrounded — but it does tell us the harness speaks the bookend
   * protocol at all, and a harness that emits one emits the other. `spec.binPath`
   * lets the operator point at any `claude` install, and on a build that predates
   * the protocol a Task's `SubagentStarted` would never be retracted: the turn
   * would sit visibly running for the full `SUBAGENT_LINGER_CAP` after the work
   * finished. So a Task whose `tool_result` lands with no `task_started` on
   * record is settled by that `tool_result` instead (see the "user" case).
   */
  readonly bookended: Set<string>
}

export const backgroundTaskState = (): BackgroundTaskState => ({
  meta: new Map(),
  live: new Set(),
  ever: new Set(),
  bookended: new Set()
})

/**
 * Harness `task_type`s that mean "a delegated agent", not operator work.
 *
 * `subagent` is the synchronous `Task`; `local_agent` is the async `Agent` tool.
 * Both already own a watch-only tab, so neither belongs in the dock.
 */
const SUBAGENT_TASK_TYPES = new Set(["subagent", "local_agent"])

/**
 * Is this live background task a delegated sub-agent rather than operator work?
 *
 * Checked against the memo `task_started` left us FIRST — that edge carries the
 * authoritative `subagent_type` — and falls back to the level's own fields for a
 * task whose start we never saw.
 *
 * The fallback is NOT the rare path it reads as. The SDK documents the level as
 * preceding the bookends, and it does: `background_tasks_changed` lands before
 * the `task_started` that would fill `meta`, so EVERY task is classified by the
 * level's own fields the first time we see it — and that payload carries only
 * `task_id`, `task_type` and `description`. No `subagent_type`. So `task_type`
 * is the whole test in practice, and it must name every delegated kind: an async
 * `Agent` says `local_agent`, and matching only `subagent` put it in the dock,
 * which then suppressed its `SubagentEnded` (see the `task_notification` case)
 * and left the tab reading "running" for the rest of the session.
 */
const isSubagentTask = (task: { task_type?: unknown; subagent_type?: unknown }, bg: BackgroundTaskState): boolean => {
  const meta = bg.meta.get(String((task as { task_id?: unknown }).task_id))
  if (meta) return SUBAGENT_TASK_TYPES.has(meta.taskType) || meta.subagentType !== null
  return SUBAGENT_TASK_TYPES.has(String(task.task_type)) || strOf(task.subagent_type) !== null
}

export const streamEventsFor = (
  msg: SDKMessage,
  tools: Map<string, ToolMemo>,
  /**
   * Omitted by callers that only rebuild transcripts (see the backfill script):
   * background-task events are session-level and have no place in a message
   * fold, so without this the mapping stays exactly as it was.
   */
  bg?: BackgroundTaskState
): ReadonlyArray<StreamEvent> => {
  // The SDK stamps a sub-agent's own messages with the spawning `Task` tool_use
  // id. When set, this message's content belongs to that sub-agent's live tab,
  // not the main turn — so we tag each emitted content event with it.
  const agentId = strOf((msg as { parent_tool_use_id?: unknown }).parent_tool_use_id) || undefined
  const forAgent = agentId ? { agentId } : {}

  switch (msg.type) {
    case "system": {
      // ── Background tasks ────────────────────────────────────────────────
      // `background_tasks_changed` carries the full live set and is the ONLY
      // reliable answer to "is this task backgrounded". `task_started` fires for
      // foreground tasks too — every synchronous sub-agent — so emitting a
      // background event off it would fill the dock with ordinary delegated work
      // that is not backgrounded at all. The level therefore GATES the edges: we
      // remember every task's metadata, but only promote a task to the dock once
      // the harness lists it as live in the background.
      if (msg.subtype === "background_tasks_changed" && bg) {
        const all = Array.isArray(msg.tasks) ? msg.tasks : []
        // The dock is for work the OPERATOR has to mind: dev servers, watchers,
        // long-running shell. Delegated sub-agents are not that — the SDK
        // backgrounds every `Task` by default, so admitting them fills the dock
        // with ordinary exploration that already has its own watch-only tab.
        // Drop them here (the single choke point) so the dock, its counter, and
        // the background-task actors all agree on what counts.
        const tasks = all.filter((t) => !isSubagentTask(t, bg))
        const ids = tasks.map((t) => String(t.task_id))
        const out: StreamEvent[] = []
        for (const task of tasks) {
          const id = String(task.task_id)
          if (bg.ever.has(id)) continue
          bg.ever.add(id)
          // Prefer the metadata `task_started` gave us; the level's own fields
          // are the fallback when we never saw (or already discarded) that edge.
          const meta = bg.meta.get(id)
          out.push({
            _tag: "BackgroundTaskStarted",
            id,
            description: meta?.description ?? String(task.description ?? "Background task"),
            taskType: meta?.taskType ?? String(task.task_type ?? "unknown"),
            subagentType: meta?.subagentType ?? null,
            toolUseId: meta?.toolUseId ?? null
          })
        }
        bg.live.clear()
        for (const id of ids) bg.live.add(id)
        out.push({ _tag: "BackgroundTasksChanged", ids })
        return out
      }

      // Metadata only. A task that is never backgrounded never reaches the dock;
      // one that IS gets promoted above with the details remembered here.
      if (msg.subtype === "task_started" && bg) {
        const id = strOf(msg.task_id)
        // Recorded before the `task_id` guard: the version gate is keyed on the
        // tool_use, and an ambient task with no id still proves the protocol.
        const startedToolUse = strOf(msg.tool_use_id)
        if (startedToolUse) bg.bookended.add(startedToolUse)
        if (!id) return []
        bg.meta.set(id, {
          description: strOf(msg.description) ?? "Background task",
          taskType: strOf(msg.task_type) ?? (strOf(msg.subagent_type) ? "subagent" : "unknown"),
          subagentType: strOf(msg.subagent_type),
          toolUseId: strOf(msg.tool_use_id)
        })
        return []
      }

      if (msg.subtype === "task_progress" && bg) {
        const id = strOf(msg.task_id)
        if (!id || !bg.live.has(id)) return []
        return [
          {
            _tag: "BackgroundTaskProgress",
            id,
            description: strOf(msg.description) ?? "Background task",
            tokens: numOf(msg.usage?.total_tokens),
            toolUses: numOf(msg.usage?.tool_uses),
            durationMs: numOf(msg.usage?.duration_ms),
            lastTool: strOf(msg.last_tool_name)
          }
        ]
      }

      // A task's terminal bookend, and the AUTHORITATIVE completion for a
      // sub-agent. It is the only correct signal for a BACKGROUNDED Task, whose
      // `tool_result` arrives ~150ms after the spawn carrying just an "Async
      // agent launched successfully" ACK while the agent runs on for minutes.
      // It fires for SYNCHRONOUS Tasks too (just before their tool_result), so
      // settling here — rather than on the tool_result — is right either way.
      if (msg.subtype === "task_notification") {
        const out: StreamEvent[] = []
        const taskId = strOf(msg.task_id)
        // Settle the dock row for a task we ever promoted. Keyed on `ever`, not
        // `live`: the id leaves the live set the moment it finishes, and the
        // level may well arrive before this bookend.
        if (taskId && bg?.ever.has(taskId)) {
          bg.live.delete(taskId)
          out.push({
            _tag: "BackgroundTaskSettled",
            id: taskId,
            // `stopped` is the operator's own kill — not a failure to report.
            status:
              msg.status === "completed" ? "completed" : msg.status === "stopped" ? "stopped" : "failed",
            summary: strOf(msg.summary),
            outputFile: strOf(msg.output_file)
          })
        }
        // Ambient/workflow tasks carry no tool_use_id: no tab to settle. Nor does
        // a task we promoted to the DOCK — its tab was retracted when it was
        // backgrounded, so settling it here would address an id that no longer
        // exists. (Harmless today, since `applySubagentEvent` guards on
        // membership, but it is the one place a background task is still spoken
        // about as a sub-agent — so don't say it.)
        const id = strOf(msg.tool_use_id)
        // A notification proves the protocol just as a `task_started` does, so a
        // harness that dropped the start edge still suppresses the tool_result
        // fallback below rather than settling the tab twice.
        if (id && bg) bg.bookended.add(id)
        if (id && !(taskId && bg?.ever.has(taskId))) {
          // `stopped` is carried through rather than flattened to `error`: it is
          // the operator's own kill (the tab's ×), and a red dot would send them
          // back to read a transcript they already decided to abandon.
          out.push({
            _tag: "SubagentEnded",
            id,
            status: msg.status === "completed" ? "done" : msg.status === "stopped" ? "stopped" : "error"
          })
        }
        return out
      }
      if (msg.subtype !== "init") return []
      const model = strOf(msg.model)
      return [
        model
          ? { _tag: "Started", sessionId: msg.session_id, model }
          : { _tag: "Started", sessionId: msg.session_id }
      ]
    }

    // Token-level streaming: assistant text arrives as content_block deltas.
    case "stream_event": {
      const event = (msg as { event?: { type?: string; delta?: Record<string, unknown> } }).event
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = strOf(event.delta.text)
        return text ? [{ _tag: "Assistant", text, ...forAgent }] : []
      }
      return []
    }

    // The completed assistant message carries thinking (as a finished block) and
    // tool_use calls. Text is skipped here — it already streamed via deltas.
    case "assistant": {
      if (msg.error === "authentication_failed") {
        return [
          {
            _tag: "Failed",
            message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
          }
        ]
      }
      const out: StreamEvent[] = []
      for (const block of contentBlocks(msg.message)) {
        const type = block.type
        if (type === "thinking") {
          const text = strOf(block.thinking)
          if (text) out.push({ _tag: "Thinking", text, seconds: null, done: true, ...forAgent })
        } else if (type === "tool_use") {
          const id = String(block.id)
          const name = String(block.name)
          const input = (block.input ?? {}) as Record<string, unknown>
          tools.set(id, { name, input })
          // A `Task` opens a live, watch-only sub-agent tab keyed by this tool_use
          // id (its children arrive stamped with it). This holds at ANY depth: a
          // Task spawned BY a sub-agent (so `agentId` is set) opens a nested tab
          // parented to it, since the SDK stamps the immediate parent.
          if (SUBAGENT_TOOLS.has(name)) {
            out.push({
              _tag: "SubagentStarted",
              id,
              name: strOf(input.subagent_type) ?? "agent",
              description: strOf(input.description) ?? "",
              parentId: agentId ?? null
            })
          }
          if (SUPPRESSED_TOOLS.has(name)) continue
          // The Task's own ToolStart carries its SPAWNER's agentId (undefined for
          // the main agent), so the summary card anchors in the transcript that
          // made the call — the main turn, or the parent sub-agent's tab — while
          // the tab opened above holds the spawned agent's own output.
          out.push({ _tag: "ToolStart", id, name, target: toolTarget(name, input), ...forAgent })
        }
      }
      // Each assistant message exposes the latest context window. Only the main
      // agent's context drives the readout; sub-agents have independent windows.
      if (agentId === undefined) {
        const tokens = contextTokens(msg.message.usage)
        if (tokens > 0) out.push({ _tag: "Usage", tokens })
      }
      return out
    }

    case "user": {
      const out: StreamEvent[] = []
      for (const block of contentBlocks(msg.message)) {
        if (block.type !== "tool_result") continue
        const id = String(block.tool_use_id)
        const memo = tools.get(id)
        // NOTE: a Task's tool_result deliberately does NOT settle its tab — for a
        // backgrounded Task it's only a launch ACK, so settling here flipped the
        // tab to "done" ~150ms in while the agent ran on for minutes. The tab is
        // settled by the `task_notification` bookend (see the "system" case).
        if (memo && SUPPRESSED_TOOLS.has(memo.name)) continue
        const stats = memo && isEditTool(memo.name) ? editStats(memo.name, memo.input) : { diff: null, preview: null }
        const output = toolResultOutput(memo?.name, block.content)
        out.push({
          _tag: "ToolEnd",
          id,
          status: block.is_error === true ? "error" : "success",
          meta: toolResultMeta(memo?.name, block.content),
          diff: stats.diff,
          preview: stats.preview,
          // Omit the key entirely when there's nothing to show, so a tool with no
          // output doesn't persist an empty field into every transcript.
          ...(output !== undefined ? { output } : {}),
          ...forAgent
        })
        // The version-gated fallback for the NOTE above. A Task the harness never
        // bookended with a `task_started` will never get a `task_notification`
        // either, so its `SubagentStarted` would never be retracted: the tab would
        // read "running" forever and — worse — the turn would be held open for the
        // full `SUBAGENT_LINGER_CAP` after the delegated work was already done.
        // On any harness that speaks the protocol this is dead code, because the
        // start edge always precedes the tool_result.
        if (bg && memo && SUBAGENT_TOOLS.has(memo.name) && !bg.bookended.has(id)) {
          out.push({ _tag: "SubagentEnded", id, status: block.is_error === true ? "error" : "done" })
        }
      }
      return out
    }

    case "result": {
      if (msg.subtype !== "success") {
        // Guarded like every other SDK field here (`strOf`, `numOf`,
        // `Array.isArray(msg.tasks)`): the CLI on the user's machine is not
        // version-locked to the SDK types, and a bare `.find` on an absent
        // `errors` throws inside the mapper — killing event mapping for the
        // whole run, which is worse than the generic message it replaces.
        const errors = Array.isArray(msg.errors) ? msg.errors : []
        const reason = errors.find((error) => strOf(error)?.trim())
        return [{ _tag: "Failed", message: strOf(reason)?.trim() ?? "Claude run failed." }]
      }
      // `msg.result` carries the actual error text on an is_error success —
      // the generic string throws away the one detail worth reporting.
      if (msg.is_error === true) {
        return [{ _tag: "Failed", message: strOf(msg.result)?.trim() ?? "Claude run failed." }]
      }
      return [
        {
          _tag: "Done",
          costUsd: numOf((msg as { total_cost_usd?: unknown }).total_cost_usd),
          /**
           * The run's CUMULATIVE token spend — what `addUsage` accrues into the
           * session's lifetime total beside `costUsd`.
           *
           * NOT a context reading, and never to be used as one. The result
           * message's `usage` sums every sampling call in the turn, so its
           * `cache_read_input_tokens` counts the same resident context once per
           * tool call; a ten-tool turn inside a 90k window reports ~900k here.
           * Context occupancy is reported separately, by `Usage` events.
           */
          tokens: runTokens(msg.usage)
        }
      ]
    }

    default:
      return []
  }
}

// ── The live adapter ─────────────────────────────────────────────────────────

/**
 * Run one Claude turn in the session's worktree. Streams normalized events via
 * `ctx.emit`, bridges the SDK's `canUseTool` onto `ctx.canUseTool`, and stores
 * the SDK session id in `resume` so the next prompt continues the conversation.
 * Interrupting the Effect aborts the underlying run.
 */
/**
 * How long an interrupted run is given to actually unwind before we stop
 * waiting. Long enough for a child process to be killed and reaped, short
 * enough that a wedged one doesn't hold the app.
 */
const TEARDOWN_GRACE = "15 seconds"

/**
 * How long a steered turn may go quiet before we call it finished.
 *
 * Every steer holds the turn's `Done` back until we know whether the CLI answers
 * inside this turn or opens another for it — and the two are indistinguishable at
 * the `result` itself, so the only way to tell them apart is to wait. Probed
 * against the real harness, the continuation's first message follows the previous
 * result immediately, so this is generous by an order of magnitude while still
 * being short enough that a steered turn does not sit visibly "running" after it
 * is done. Re-armed on every message; on expiry the withheld `Done` is emitted.
 */
const STEER_CONTINUE_GRACE = 2_500

/**
 * How long a turn may be held open by a sub-agent that has gone silent.
 *
 * Not a grace period — a leak guard, and deliberately three orders of magnitude
 * above `STEER_CONTINUE_GRACE`. A steered turn's continuation follows within
 * milliseconds, so waiting 2.5s for it is generous. A sub-agent is the opposite:
 * it runs for minutes and reports `task_progress` only sporadically, so any cap
 * short enough to feel like a grace period would close the input channel in the
 * middle of healthy work — ending the query and killing every sub-agent in it,
 * which is the exact bug this hold exists to fix. This fires only when a
 * `task_notification` never arrives at all (a harness crash, a dropped bookend),
 * and its expiry still emits the turn's real withheld `Done`.
 */
const SUBAGENT_LINGER_CAP = 10 * 60_000

/** Translate normalized remote attachments into Claude's inline HTTP MCP map. */
export const claudeMcpServers = (
  attachments: ReadonlyArray<RemoteMcpServer> | undefined
): Record<string, McpServerConfig> | undefined => {
  if (attachments === undefined || attachments.length === 0) return undefined
  const entries = new Map<string, McpServerConfig>()
  for (const attachment of attachments) {
    if (entries.has(attachment.name)) continue
    entries.set(attachment.name, {
      type: "http",
      url: attachment.url,
      headers: attachment.headers
    })
  }
  return entries.size === 0 ? undefined : Object.fromEntries(entries)
}

export const runClaude = (
  sessionId: string,
  spec: SessionSpec,
  ctx: AgentContext,
  resume: Map<string, string>
): Effect.Effect<void, CliExecError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runP = <A>(effect: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(effect)
    const abort = new AbortController()
    /**
     * Resolved once the SDK loop has actually unwound.
     *
     * Aborting only ASKS the run to stop; the `for await` loop and any in-flight
     * tool call keep going until they notice. `onInterrupt` used to fire the
     * abort and return immediately, so a timed-out plan step was reported ended
     * while its Bash command was still writing — and the executor, which runs
     * steps sequentially precisely because they share ONE worktree, started the
     * retry into those pending writes. Interruption now waits for the unwind.
     */
    let markSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })

    yield* Effect.tryPromise({
      try: async () => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk")
        const tools = new Map<string, ToolMemo>()
        const bgState = backgroundTaskState()
        /**
         * Sub-agents that have started and not yet bookended, keyed by the
         * spawning `Task`/`Agent` tool_use id.
         *
         * The turn's `Done` is withheld while this is non-empty (see the seam at
         * the `result` below). `SubagentEnded` is the authoritative removal — it
         * comes off `task_notification`, not the ~150ms "Async agent launched
         * successfully" ACK the tool_result carries — so this set is the only
         * honest answer to "has the delegated work actually finished".
         *
         * A SYNCHRONOUS Task never keeps the set non-empty at a `result`: its
         * notification fires just before its tool_result, both well inside the
         * turn. So this changes nothing for undelegated work.
         */
        const liveSubagents = new Set<string>()

        // ── Live bash output via tee (see bash-tee.ts) ──────────────────────
        // claude has no partial-output event, so an allowed Bash command is
        // rewritten to tee its output to a temp file we poll; each growth is a
        // ToolDelta on the SAME id as its ToolStart, so the card fills live.
        // toolUseId → its running stream; cleaned up when the command's ToolEnd
        // lands or the run ends.
        const teeStreams = new Map<string, TeeStream>()
        const stopTee = (toolUseId: string): void => {
          teeStreams.get(toolUseId)?.stop()
          teeStreams.delete(toolUseId)
        }
        /** Tee an allowed Bash command to a temp file, tail it as ToolDelta, and return the rewritten command. */
        const startTee = (toolUseId: string, command: string): string => {
          const stream = startTeeStream(
            toolUseId,
            command,
            (snapshot) => void runP(ctx.emit({ _tag: "ToolDelta", id: toolUseId, output: snapshot })),
            { pollMs: TEE_POLL_MS }
          )
          teeStreams.set(toolUseId, stream)
          return stream.command
        }

        // Set once `query()` returns, so `canUseTool` can flip the run out of plan
        // mode when the operator approves the plan.
        let planQuery: Query | null = null
        let planCount = 0
        let qn = 0
        // Whether we've already bounced a fence-less plan back for a reformat on
        // this run. Exactly one retry: a model that still won't comply degrades to
        // the raw fallback instead of ping-ponging forever.
        let planReformatAsked = false

        const canUseTool = async (
          toolName: string,
          input: Record<string, unknown>,
          options: { toolUseID: string }
        ): Promise<PermissionResult> => {
          // Plan mode: the SDK routes ExitPlanMode approval here. Turn the plan
          // into a structured, reviewable Plan and honour the operator's verdict.
          if (toolName === "ExitPlanMode") {
            const raw = strOf(input.plan) ?? ""
            // `planModeInstructions` documents the ` ```plan ` fence, but a model
            // can still skip it — and then the operator gets a plan with no
            // reviewable steps. Bounce the FIRST offender back through the same
            // deny.message channel a revision uses; it re-calls ExitPlanMode with
            // the fence and nobody sees the broken version.
            if (!hasPlanBlock(raw) && !planReformatAsked) {
              planReformatAsked = true
              return { behavior: "deny", message: PLAN_REFORMAT }
            }
            planCount += 1
            const plan = parsePlan(raw, `plan_${sessionId}_${planCount}`)
            if (plan.structured === false && !planReformatAsked) {
              planReformatAsked = true
              return { behavior: "deny", message: PLAN_REFORMAT }
            }
            const decision = await runP(ctx.proposePlan(plan))
            if (decision._tag === "Approve") {
              // Exit plan mode via "default" — the same mode every non-plan run
              // uses (see `mapPermissionMode`), so canUseTool below keeps being
              // consulted and enforces the session's restored HITL mode; an
              // "auto" approval still runs ungated via `verdict()`. Best-effort:
              // never let a permission-mode hiccup block the approval.
              try {
                await planQuery?.setPermissionMode("default")
              } catch {
                /* ignore — the tool is still allowed and canUseTool governs gating */
              }
              return {
                behavior: "allow",
                updatedInput:
                  decision.plan === undefined
                    ? input
                    : { ...input, plan: decision.plan.raw }
              }
            }
            return {
              behavior: "deny",
              message:
                decision._tag === "Revise"
                  ? decision.feedback
                  : decision._tag === "Delegate"
                    ? "Plan approved. Jingler is executing it with assigned worker agents."
                    : "Plan rejected by the operator."
            }
          }
          // Confinement first, and ahead of `toPermissionRequest`: read tools
          // are never gated, so a check that ran after it would miss exactly the
          // case this exists for.
          if (spec.unattended === true) {
            const escaped = escapingPath(spec.cwd, input)
            if (escaped !== null) {
              return {
                behavior: "deny",
                message:
                  `Denied: ${escaped} is outside this session's worktree. ` +
                  "Work only within the repository you were given."
              }
            }
          }
          // AskUserQuestion arrives as a PERMISSION request (not a dialog) in this
          // SDK — running it headlessly just skips. So we intercept it: dock our
          // question card, collect the picks, and hand them back. `canUseTool` can
          // only allow/deny, and `deny.message` is the only channel that returns
          // content to the model — so we deny with the answers phrased as the reply.
          if (toolName === "AskUserQuestion") {
            const questions = parseSdkQuestions(input)
            if (questions.length === 0) return { behavior: "allow", updatedInput: input }
            qn += 1
            const answers = await runP(
              ctx.askQuestion({ id: options.toolUseID ?? `q_${sessionId}_${qn}`, questions })
            )
            return { behavior: "deny", message: formatQuestionAnswer(questions, answers) }
          }
          const req = toPermissionRequest(toolName, input)
          if (req === null) return { behavior: "allow", updatedInput: input }
          const decision = await runP(ctx.canUseTool(req))
          if (decision !== "allow") return { behavior: "deny", message: "Denied by the operator." }
          // Allowed. For a Bash command, tee its output to a temp file we tail so
          // the card fills as it runs. Permission was decided on the ORIGINAL
          // command just above, so the rewrite can NEVER introduce a prompt; and
          // if the SDK declined to honour the changed command, streaming simply
          // no-ops — the original runs and ToolEnd still carries the full output.
          const teeId = options.toolUseID
          if (toolName === "Bash" && typeof input.command === "string" && input.command.length > 0 && teeId) {
            return { behavior: "allow", updatedInput: { ...input, command: startTee(teeId, input.command) } }
          }
          return { behavior: "allow", updatedInput: input }
        }

        // Resume id: prefer the live in-memory id (this launch), else the id
        // persisted on the session (survives an app restart), so "continue" always
        // reloads the full conversation instead of starting the harness fresh.
        // `fresh` bypasses the map entirely — the map otherwise WINS over
        // spec.resumeId, so a repeated run under the same key resumes the prior
        // conversation even when the caller explicitly asked for a new one.
        const resumeId = spec.fresh
          ? undefined
          : (resume.get(sessionId) ?? spec.resumeId ?? undefined)

        // Passed INLINE (not via `.mcp.json`) so configured sources bypass
        // Claude's project-approval prompt after the operator opted in through
        // Jingler. The same HTTP shape carries the authenticated Preview server.
        const mcpServers = claudeMcpServers(spec.remoteMcpServers)

        // Always the SDK's streaming-input form, and deliberately so: it is what
        // keeps the query open for `Agent.steer` to push into (see `makeLiveInput`).
        // The channel is closed on the turn's `result` below, which is what lets
        // the query end at all.
        const live = makeLiveInput(spec, resumeId)
        const iterator = query({
          prompt: live.iterable,
          options: {
            ...(mcpServers ? { mcpServers } : {}),
            // Never `|| undefined`: an empty cwd makes the SDK inherit the app's
            // working directory, pointing the agent at whatever repo Jingler itself
            // was launched from instead of the session's worktree.
            cwd: requireWorktree(spec.cwd, `session ${sessionId}`),
            pathToClaudeCodeExecutable: spec.binPath ?? undefined,
            // Run on the operator's Claude plan where they have one. The SDK
            // REPLACES the child environment with this rather than merging, so
            // `harnessEnv` returns a complete copy. See `subscription.ts`.
            // Layered over `worktreeEnv` so the agent also stops inheriting the
            // toolchain config of whatever repo Jingler was launched from —
            // the env-var counterpart of the `cwd` hazard noted above.
            env: harnessEnv(
              "claude",
              worktreeEnv(process.env, spec.cwd ?? undefined),
              hasSubscriptionAuth("claude")
            ),
            // An unattended agent gets the OS-level credential denylist as well
            // as the file-tool check below — the latter cannot see a shell, and
            // a plan step needs one. See `sandbox.ts` for what this does and,
            // more importantly, what it does not.
            ...(spec.unattended === true ? { sandbox: unattendedSandbox() } : {}),
            model: spec.model ?? undefined,
            permissionMode: mapPermissionMode(spec.mode),
            ...mapClaudeReasoning(spec.reasoningEffort, spec.thinkingEnabled),
            ...(spec.mode === "plan"
              ? {
                  planModeInstructions: planModeInstructions(
                    spec.planTemplate,
                    spec.orchestrationRoutes,
                    spec.workerRouting
                  )
                }
              : {}),
            ...(spec.readOnly ? { disallowedTools: [...READ_ONLY_DISALLOWED] } : {}),
            includePartialMessages: true,
            canUseTool,
            abortController: abort,
            resume: resumeId
          }
        })
        planQuery = iterator

        // Did this run ever settle? The SDK stream can close without a `result`
        // message (child killed, CLI crash, stdout EOF) and a `for await` that
        // simply ends is a normal return — nothing threw, so the `catch` below
        // never fires. The turn was then left with `streaming: true` forever, or
        // re-read as a silent empty assistant block after a reload.
        let terminal = false
        // Publish the steer handle: from here until the turn closes, a queued
        // message can be pushed straight into the live turn. Claude delivers it
        // at the next tool boundary, which is exactly the queue's promise.
        if (ctx.registerTurnSteer !== undefined) {
          await runP(
            ctx.registerTurnSteer(async (text, images) =>
              live.push(text, images) ? "accepted" : "deferred"
            )
          )
        }
        // Publish the per-task kill handle for this run.
        //
        // It takes EITHER id, because its two callers hold different ones: the
        // dock knows a task by the harness's `task_id`, while a sub-agent tab
        // has only ever known the spawning tool_use id. `bgState.meta` is the
        // one place the two are correlated (it is filled from `task_started`,
        // which carries both), and it lives here — inside the run that owns the
        // query — so the translation belongs here rather than on the wire.
        //
        // A tool_use id that resolves to nothing is passed through unchanged
        // rather than dropped: the harness is the authority on what its ids
        // mean, and `stopTask` rejecting is already handled by the caller.
        await runP(
          ctx.registerBackgroundStop(async (id) => {
            const byToolUse = [...bgState.meta].find(([, memo]) => memo.toolUseId === id)
            await iterator.stopTask(byToolUse ? byToolUse[0] : id)
          })
        )
        /**
         * The `Done` withheld from a turn a late steer extended, if any.
         *
         * Held rather than dropped: if the continuation never materialises, the
         * stream closes with nothing terminal, and the "ended without responding"
         * fallback below would report a FAILURE for a turn that actually completed.
         */
        let withheldDone: StreamEvent | null = null
        /**
         * Safety net for that same case: while a `Done` is withheld, the only thing
         * that can end the query is a later `result`, so a continuation that stalls
         * would park the input generator forever and leave the turn streaming with
         * no way out.
         *
         * Armed and disarmed around EVERY message, not just results — a
         * continuation is mostly partial and system frames, so arming only at
         * results meant the first such frame disarmed the net permanently and the
         * wedge it exists to break went unguarded from there on.
         *
         * Its DURATION comes from why the turn is being held (see
         * `turn-continuation.ts`): `STEER_CONTINUE_GRACE` for a continuation that
         * should arrive in milliseconds, `SUBAGENT_LINGER_CAP` for delegated work
         * that legitimately runs for minutes. One timer, two very different waits —
         * a single grace period cannot serve both.
         */
        let holdTimer: ReturnType<typeof setTimeout> | null = null
        const disarmHold = () => {
          if (holdTimer === null) return
          clearTimeout(holdTimer)
          holdTimer = null
        }
        /**
         * Whether a steer is still waiting to be answered — sticky across messages.
         *
         * Not derivable a second time, which is the whole reason it is a variable.
         * `takeSteered()` is a consuming read and the SDK pulls a pushed message out
         * of the channel within a microtask, so by the foot of the loop `hasUnread()`
         * reports false whether or not the CLI has acted on it. Asking again from
         * scratch therefore said "nothing pending" and closed the channel at 0ms —
         * cutting the very continuation the push had just opened, and leaving the
         * operator's message accepted but unanswered.
         *
         * Kept as its OWN fact rather than read back off the last verdict's reason:
         * a steer noticed while sub-agents are live yields `subagent-work` (the
         * longer timer wins), so remembering the reason instead would forget the
         * steer and close as soon as the last bookend landed.
         *
         * Cleared by a `result`, which is what actually answers it.
         */
        let steerPending = false
        try {
          for await (const msg of iterator) {
            disarmHold()
            const sid = (msg as { session_id?: unknown }).session_id
            // A `fresh` run must leave no trace in the map, or the NEXT run under
            // this key would resume it.
            if (!spec.fresh && typeof sid === "string" && sid.length > 0) {
              resume.set(sessionId, sid)
            }
            /**
             * Mapped BEFORE the seam decision, because the events are what say
             * whether this message ends the run: a `result` becomes `Done` or
             * `Failed` depending on `subtype`/`is_error`, and re-deriving that here
             * would be a second copy of the mapper's rule, free to drift from it.
             *
             * Safe to do early — mapping is pure with respect to the query. It only
             * feeds `tools`/`bgState`, never the child or the input channel, so
             * nothing below depends on it having run late.
             */
            const events = streamEventsFor(msg, tools, bgState)
            // Keep the live sub-agent set current before anything reads it. Both
            // edges come from the mapper: `SubagentStarted` off the `Task` tool_use,
            // `SubagentEnded` off the `task_notification` bookend. The errored
            // `ToolEnd` is the leak guard — a Task that dies without a notification
            // would otherwise hold the turn open until `SUBAGENT_LINGER_CAP`.
            for (const event of events) {
              if (event._tag === "SubagentStarted") liveSubagents.add(event.id)
              if (event._tag === "SubagentEnded") liveSubagents.delete(event.id)
              if (event._tag === "ToolEnd" && event.status === "error") {
                liveSubagents.delete(event.id)
              }
            }
            /**
             * Whether this `result` is the end of the run, or a seam in it.
             *
             * A steered message the CLI has ALREADY taken is answered inside the
             * running turn — probed against the real harness, which emits exactly
             * one `result` for it (`scripts/probe-claude-steer.ts`). So the common
             * case is: this result ends the run, emit `Done`, close the channel.
             *
             * Two exceptions, both in `turn-continuation.ts`: a push that landed in
             * the last few milliseconds and has not been read yet, and sub-agents
             * that are still working. In either case the channel stays open and this
             * result's `Done` is withheld — it would settle a conversation that is
             * about to continue, or (worse, for sub-agents) end the one query every
             * sub-agent is running inside.
             */
            let extended = false
            if ((msg as { type?: unknown }).type === "result") {
              // The turn is ending: ask the harness how full the window actually
              // is, and emit that BEFORE the `Done` it belongs to. Ordering is
              // load-bearing — `Done` is what starts a compaction decision, and
              // the decision reads the latest `Usage`, so a probe emitted after it
              // would be one turn late every time.
              //
              // It also goes before `finish()`, while the query is still live: the
              // probe is a control request to the child, and closing the input
              // channel starts the SDK shutting that child down, so probing after
              // the close races the teardown and loses the reading entirely.
              const probe = await probeContextUsage(iterator)
              if (probe !== null) {
                await runP(
                  ctx.emit({
                    _tag: "Usage",
                    tokens: probe.tokens,
                    ...(probe.window > 0 ? { window: probe.window } : {})
                  })
                )
              }
              // Read as LATE as possible: a push that arrives during the probe is
              // then still seen here rather than stranded by the close below.
              //
              // `takeSteered` AND `hasUnread`, not just the latter: the SDK pulls a
              // pushed message out of the channel within a microtask, so by now it
              // usually looks empty whether or not the CLI has acted on it. Probing
              // the real harness in exactly that state showed a SECOND turn follows,
              // so a result after any push is treated as a seam until the stream
              // goes quiet. `takeSteered()` is a CONSUMING read, so it is called
              // here exactly once and its value handed to the policy — never
              // re-read, and never behind a `||` that could short-circuit past it.
              // The wait is bounded by the timer armed at the foot of this loop,
              // once per message, off `withheldDone`.
              const steered = live.takeSteered()
              const unread = live.hasUnread()
              const verdict = turnContinuation({
                steered,
                unread,
                liveSubagents: liveSubagents.size,
                terminalKind: events.some((event) => event._tag === "Failed")
                  ? "failed"
                  : events.some((event) => event._tag === "Done")
                    ? "done"
                    : null
              })
              extended = verdict.kind === "continue"
              // This result ANSWERS a steer, so it also resets the memory — re-seeded
              // from the reads above so a push that arrived during the probe still
              // counts, and set independently of which reason won the timer.
              steerPending = extended && (steered || unread)
              if (!extended) live.finish()
            }
            for (const event of events) {
              // A command has finished: its ToolEnd carries the authoritative
              // output, so stop tailing and drop the temp file BEFORE emitting —
              // otherwise a late poll could re-open the settled card. A no-op for
              // any tool that wasn't teed.
              if (event._tag === "ToolEnd") stopTee(event.id)
              // The continuation's own result will carry the real `Done`; this one
              // is withheld, not dropped (see `withheldDone`).
              if (extended && event._tag === "Done") {
                withheldDone = event
                continue
              }
              if (event._tag === "Done" || event._tag === "Failed") {
                terminal = true
                withheldDone = null
                steerPending = false
                // A terminal event we are NOT withholding ends the run, so the
                // channel must close or the input generator parks forever with
                // nothing left to wake it. Already done for a `result` (the policy
                // said close); this covers a `Failed` mapped from anything else,
                // which would otherwise fall between the two and wedge the query.
                // `finish()` is idempotent.
                disarmHold()
                live.finish()
              }
              await runP(ctx.emit(event))
            }
            // Re-arm after every message while a `Done` is being withheld, since
            // the top of the loop disarmed it. A continuation is mostly partial and
            // system frames, so arming only at results left the FIRST such frame
            // holding the door open forever: nothing would ever close the input
            // channel again, and a continuation that stalled would leave the turn
            // streaming until the operator stopped it by hand.
            //
            // Asked of the same policy as the seam, so the two cannot disagree: a
            // sub-agent that bookended while the turn was held gets the channel
            // closed HERE, which returns the input generator, exits this loop, and
            // lets the post-loop branch emit the withheld `Done` for real.
            if (withheldDone !== null) {
              // A push that landed since the last read still counts, and a steer
              // noticed at any point during the hold KEEPS counting until a result
              // resolves it — see `steerPending`. Asking `hasUnread()` alone reports
              // false the moment the SDK takes the message, which is precisely when
              // the answer matters.
              steerPending = steerPending || live.takeSteered() || live.hasUnread()
              const held = turnContinuation({
                steered: steerPending,
                unread: false,
                liveSubagents: liveSubagents.size,
                terminalKind: null
              })
              if (held.kind === "close") live.finish()
              else {
                holdTimer = setTimeout(
                  () => live.finish(),
                  held.because === "subagent-work" ? SUBAGENT_LINGER_CAP : STEER_CONTINUE_GRACE
                )
              }
            }
          }
          // A withheld `Done` outlived the turn it belonged to: the continuation we
          // held the channel open for never came. The turn DID complete, so emit the
          // real terminal event rather than letting the failure fallback below
          // report "ended without responding" for a run that answered fine.
          //
          // Guarded on the abort exactly as the fallback below is, and for the same
          // reason: an operator Stop closes the SDK iterator, and it does not always
          // close it by throwing. A clean close during the hold would otherwise
          // report the stopped run as `Done`, racing the stop path's own `Failed` —
          // and the hold is now a sub-agent window measured in minutes, not a 2.5s
          // steer grace, so the odds of a Stop landing inside it are no longer small.
          if (!terminal && withheldDone !== null && !abort.signal.aborted) {
            terminal = true
            await runP(ctx.emit(withheldDone))
          }
          // The stream ended without saying how. An interrupt has its own
          // terminal event (the stop path emits `Failed`), so only a silent
          // close is reported here — better a visible reason than a turn that
          // renders as an empty response.
          if (!terminal && !abort.signal.aborted) {
            await runP(
              ctx.emit({
                _tag: "Failed",
                message: "Claude ended the turn without responding (the harness stream closed early). Try again."
              })
            )
          }
        } finally {
          // End of run (or a throw / interrupt-driven iterator close): tear down
          // any watcher still open — a command whose ToolEnd never arrived, or the
          // operator stopping mid-command — so no timer or temp file outlives it.
          disarmHold()
          // Close the input channel and retract the steer handle together: a live
          // handle after the turn would accept a message into a query that is gone,
          // reporting `accepted` for a message nothing will ever read.
          live.finish()
          if (ctx.registerTurnSteer !== undefined) await runP(ctx.registerTurnSteer(null))
          for (const id of [...teeStreams.keys()]) stopTee(id)
          markSettled()
        }
      },
      catch: (cause) =>
        new CliExecError({
          kind: spec.cli,
          message: cause instanceof Error ? cause.message : String(cause)
        })
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => abort.abort()).pipe(
          Effect.andThen(Effect.promise(() => settled)),
          // Bounded: a wedged child process must not hang the app forever. If it
          // outlives this, the retry races it again — but a bounded wait closes
          // the common case, and an unbounded one trades a rare corruption for a
          // guaranteed hang.
          Effect.timeout(TEARDOWN_GRACE),
          Effect.ignore
        )
      )
    )
  })
