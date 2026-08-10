import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { FileChangeSet, type StreamEvent } from "@jingler/core"
import { Option, Schema } from "effect"

const TextResultPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})
const ToolContent = Schema.Struct({
  content: Schema.Array(Schema.Unknown)
})
const FileChangeDetails = Schema.Struct({ fileChanges: FileChangeSet })
const ToolDetails = Schema.Struct({ details: FileChangeDetails })

const decodeText = Schema.decodeUnknownOption(TextResultPart)
const decodeContent = Schema.decodeUnknownOption(ToolContent)
const decodeDetails = Schema.decodeUnknownOption(ToolDetails)

type ToolResultEvent = Extract<
  AgentSessionEvent,
  { readonly type: "tool_execution_update" | "tool_execution_end" }
>

const projectToolResult = (event: ToolResultEvent): {
  readonly output?: string
  readonly fileChanges?: typeof FileChangeSet.Type
} => {
  const result =
    event.type === "tool_execution_update" ? event.partialResult : event.result
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
    ...(details === undefined
      ? {}
      : { fileChanges: details.details.fileChanges })
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
  if (update.type === "error") {
    return {
      _tag: "Failed",
      message: update.error.errorMessage ?? "Provider request failed"
    }
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
  event: Extract<AgentSessionEvent, { readonly type: "message_end" }>
): StreamEvent | null =>
  event.message.role === "assistant"
    ? { _tag: "Usage", tokens: event.message.usage.totalTokens }
    : null

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
  event: AgentSessionEvent
): StreamEvent | null => {
  switch (event.type) {
    case "message_update":
      return normalizeMessageUpdate(event)
    case "message_end":
      return normalizeMessageEnd(event)
    case "tool_execution_start":
      return {
        _tag: "ToolStart",
        id: event.toolCallId,
        name: event.toolName,
        target: null
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
