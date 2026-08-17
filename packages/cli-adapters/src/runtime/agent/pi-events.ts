import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { FileChangeSet, type StreamEvent } from "@jingler/core"
import { Option, Schema } from "effect"
import type {
  PiSubagentProgressInput,
  PiSubagentSupervisorAttentionInput
} from "../subagents/pi-subagent-lifecycle-adapter.js"

const TextResultPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})
const ToolContent = Schema.Struct({
  content: Schema.Array(Schema.Unknown)
})
const FileChangeDetails = Schema.Struct({ fileChanges: FileChangeSet })
const ToolDetails = Schema.Struct({ details: FileChangeDetails })
const ToolTarget = Schema.Struct({
  path: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  /** Execution tools (`command_execute`, pi's `bash`) target a command line. */
  command: Schema.optional(Schema.String),
  /** Browser tools target a URL, a CSS selector, or a JS expression. */
  url: Schema.optional(Schema.String),
  selector: Schema.optional(Schema.String),
  expression: Schema.optional(Schema.String)
})

const decodeText = Schema.decodeUnknownOption(TextResultPart)
const decodeContent = Schema.decodeUnknownOption(ToolContent)
const decodeDetails = Schema.decodeUnknownOption(ToolDetails)
const decodeTarget = Schema.decodeUnknownOption(ToolTarget)
const SupervisorAttention = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.Literal("subagent_supervisor_request"),
  content: Schema.String,
  timestamp: Schema.Number,
  details: Schema.Struct({
    id: Schema.String,
    reason: Schema.Literal("need_decision", "interview_request", "progress_update"),
    expectsReply: Schema.Boolean,
    runId: Schema.String,
    agent: Schema.String,
    childIndex: Schema.Number
  })
})
const decodeSupervisorAttention = Schema.decodeUnknownOption(SupervisorAttention)
const SubagentProgress = Schema.Struct({
  mode: Schema.String,
  runId: Schema.String,
  progress: Schema.Array(Schema.Struct({
    index: Schema.Number,
    agent: Schema.String,
    status: Schema.Literal("pending", "running", "completed", "failed", "detached"),
    task: Schema.String,
    currentTool: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    tokens: Schema.Number,
    toolCount: Schema.Number,
    durationMs: Schema.Number,
    error: Schema.optional(Schema.String)
  })),
  results: Schema.Array(Schema.Struct({
    index: Schema.Number,
    runId: Schema.optional(Schema.String),
    sessionFile: Schema.optional(Schema.String)
  }))
})
const decodeSubagentProgress = Schema.decodeUnknownOption(SubagentProgress)

type ToolResultEvent = Extract<
  AgentSessionEvent,
  { readonly type: "tool_execution_update" | "tool_execution_end" }
>

const toolTarget = (
  event: Extract<AgentSessionEvent, { readonly type: "tool_execution_start" }>
): string | null => {
  const target = Option.getOrUndefined(decodeTarget(event.args))
  if (target?.path !== undefined) return target.path
  if (target?.command !== undefined) return target.command
  if (target?.url !== undefined) return target.url
  if (target?.selector !== undefined) return target.selector
  if (target?.expression !== undefined) return target.expression
  if (target?.from !== undefined && target.to !== undefined) {
    return `${target.from} → ${target.to}`
  }
  return null
}

const projectToolResult = (
  event: ToolResultEvent
): {
  readonly output?: string
  readonly fileChanges?: typeof FileChangeSet.Type
} => {
  const result = event.type === "tool_execution_update" ? event.partialResult : event.result
  const content = Option.getOrUndefined(decodeContent(result))
  const details = Option.getOrUndefined(decodeDetails(result))

  const output = content?.content
    .flatMap((part) => {
      const decoded = Option.getOrUndefined(decodeText(part))
      return decoded === undefined ? [] : [decoded.text]
    })
    .join("\n")

  return {
    ...(output ? { output } : {}),
    ...(details === undefined ? {} : { fileChanges: details.details.fileChanges })
  }
}

const normalizeMessageUpdate = (
  event: Extract<AgentSessionEvent, { readonly type: "message_update" }>
): StreamEvent | null => {
  const update = event.assistantMessageEvent
  if (update.type === "text_delta") {
    return { _tag: "Assistant", text: update.delta }
  }
  if (update.type === "thinking_delta") {
    return { _tag: "Thinking", text: update.delta, seconds: null, done: false }
  }
  if (update.type === "thinking_end") {
    return { _tag: "Thinking", text: "", seconds: null, done: true }
  }
  return null
}

export const piSubagentProgress = (
  event: AgentSessionEvent
): PiSubagentProgressInput | null => {
  if (
    (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") ||
    event.toolName !== "subagent"
  ) return null
  const result = event.type === "tool_execution_update" ? event.partialResult : event.result
  const decoded = Option.getOrUndefined(decodeSubagentProgress(result?.details))
  if (!decoded) return null
  const results = new Map(decoded.results.map((child) => [child.index, child]))
  return {
    runId: decoded.runId,
    mode: decoded.mode,
    children: decoded.progress.map((child) => ({
      ...child,
      runId: results.get(child.index)?.runId ?? null,
      sessionFile: results.get(child.index)?.sessionFile ?? null
    }))
  }
}

export const piSupervisorAttention = (
  event: AgentSessionEvent
): PiSubagentSupervisorAttentionInput | null => {
  if (event.type !== "message_end") return null
  const message = Option.getOrUndefined(decodeSupervisorAttention(event.message))
  if (!message || !message.details.expectsReply || message.details.reason === "progress_update") {
    return null
  }
  return {
    requestId: message.details.id,
    runId: message.details.runId,
    childIndex: message.details.childIndex,
    agent: message.details.agent,
    reason: message.details.reason,
    message: message.content,
    requestedAt: message.timestamp,
    deadlineAt: null
  }
}

/** Provider errors are provisional until pi settles after its retry policy. */
export const piProviderFailure = (event: AgentSessionEvent): string | null => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "error"
  ) {
    return event.assistantMessageEvent.error.errorMessage ?? "Provider request failed"
  }
  if (
    event.type === "message_end" &&
    event.message.role === "assistant" &&
    event.message.stopReason === "error"
  ) {
    return event.message.errorMessage ?? "Provider request failed"
  }
  if (event.type === "auto_retry_end" && !event.success) {
    return event.finalError ?? "Provider request failed"
  }
  return null
}

const normalizeToolEnd = (
  event: Extract<AgentSessionEvent, { readonly type: "tool_execution_end" }>
): StreamEvent => {
  const { fileChanges, output } = projectToolResult(event)
  return {
    _tag: "ToolEnd",
    id: event.toolCallId,
    status: event.isError ? "error" : "success",
    meta: null,
    diff: fileChanges?.totals ?? null,
    preview: fileChanges?.changes.find((change) => change.preview)?.preview ?? null,
    ...(fileChanges === undefined ? {} : { fileChanges }),
    ...(output === undefined ? {} : { output })
  }
}

const normalizeMessageEnd = (
  event: Extract<AgentSessionEvent, { readonly type: "message_end" }>,
  contextWindow?: number
): StreamEvent | null => {
  if (event.message.role !== "assistant") return null
  if (event.message.stopReason === "error") return null
  return {
    _tag: "Usage",
    tokens: event.message.usage.totalTokens,
    ...(contextWindow === undefined ? {} : { window: contextWindow })
  }
}

const normalizeCompactionEnd = (
  event: Extract<AgentSessionEvent, { readonly type: "compaction_end" }>
): StreamEvent => ({
  _tag: "CompactionFinished",
  reason: event.reason,
  status: event.aborted ? "aborted" : event.result ? "success" : "failed",
  tokensBefore: event.result?.tokensBefore ?? null,
  tokensAfter: event.result?.estimatedTokensAfter ?? null,
  message: event.errorMessage ?? null
})

/**
 * Stateful wrapper over `normalizePiEvent` that times reasoning runs: the
 * clock starts on the first `thinking_delta` of a run and `thinking_end`
 * carries the elapsed whole seconds, so the transcript can settle its
 * "Thinking…" pill into "Thought for N seconds".
 */
export const createPiEventNormalizer = (now: () => number = Date.now) => {
  let thinkingStartedAt: number | null = null
  return (event: AgentSessionEvent, contextWindow?: number): StreamEvent | null => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update.type === "thinking_delta" && thinkingStartedAt === null) {
        thinkingStartedAt = now()
      }
      if (update.type === "thinking_end" && thinkingStartedAt !== null) {
        const startedAt = thinkingStartedAt
        thinkingStartedAt = null
        return {
          _tag: "Thinking",
          text: "",
          seconds: Math.max(1, Math.round((now() - startedAt) / 1000)),
          done: true
        }
      }
    }
    return normalizePiEvent(event, contextWindow)
  }
}

/** Provider-neutral projection of pi's observable event surface. */
export const normalizePiEvent = (
  event: AgentSessionEvent,
  contextWindow?: number
): StreamEvent | null => {
  switch (event.type) {
    case "message_update":
      return normalizeMessageUpdate(event)
    case "message_end":
      return normalizeMessageEnd(event, contextWindow)
    case "tool_execution_start":
      return {
        _tag: "ToolStart",
        id: event.toolCallId,
        name: event.toolName,
        target: toolTarget(event)
      }
    case "tool_execution_update":
      return {
        _tag: "ToolDelta",
        id: event.toolCallId,
        output: projectToolResult(event).output ?? ""
      }
    case "tool_execution_end":
      return normalizeToolEnd(event)
    case "auto_retry_start":
      return {
        _tag: "RetryScheduled",
        operation: "provider",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        message: event.errorMessage
      }
    case "auto_retry_end":
      return {
        _tag: "RetryFinished",
        operation: "provider",
        attempt: event.attempt,
        success: event.success,
        message: event.finalError ?? null
      }
    case "summarization_retry_scheduled":
      return {
        _tag: "RetryScheduled",
        operation: "summarization",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        message: event.errorMessage
      }
    case "compaction_start":
      return { _tag: "CompactionStarted", reason: event.reason }
    case "compaction_end":
      return normalizeCompactionEnd(event)
    default:
      return null
  }
}
