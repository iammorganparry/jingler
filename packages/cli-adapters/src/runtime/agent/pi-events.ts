import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { FileChangeSet, type StreamEvent } from "@jingler/core"
import { Option, Schema } from "effect"
import type { PiSubagentSupervisorAttentionInput } from "../subagents/pi-subagent-lifecycle-adapter.js"

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
  to: Schema.optional(Schema.String)
})

const decodeText = Schema.decodeUnknownOption(TextResultPart)
const decodeContent = Schema.decodeUnknownOption(ToolContent)
const decodeDetails = Schema.decodeUnknownOption(ToolDetails)
const decodeTarget = Schema.decodeUnknownOption(ToolTarget)
const SupervisorAttention = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.Literal("subagent_supervisor_request"),
  content: Schema.String,
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

type ToolResultEvent = Extract<
  AgentSessionEvent,
  { readonly type: "tool_execution_update" | "tool_execution_end" }
>

const toolTarget = (
  event: Extract<AgentSessionEvent, { readonly type: "tool_execution_start" }>
): string | null => {
  const target = Option.getOrUndefined(decodeTarget(event.args))
  if (target?.path !== undefined) return target.path
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
    message: message.content
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
