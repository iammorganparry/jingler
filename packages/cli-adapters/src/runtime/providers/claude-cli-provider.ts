import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage
} from "@earendil-works/pi-ai"
import { lazyStream } from "@earendil-works/pi-ai/api/lazy"
import { Option, Schema } from "effect"
import { execFileText, trackChild } from "../../child-registry.js"
import {
  startClaudeCliToolRelay,
  type ClaudeCliToolRelay,
  type RelayedToolCall
} from "./claude-cli-sampling-relay.js"

const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.Literal("claude.ai"),
  apiProvider: Schema.Literal("firstParty"),
  subscriptionType: Schema.Literal("pro", "max", "team", "enterprise")
})
const ClaudeStreamDelta = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Number,
    delta: Schema.Union(
      Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
      Schema.Struct({ type: Schema.Literal("thinking_delta"), thinking: Schema.String })
    )
  })
})
const ClaudeRequestUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number)
})
const ClaudeResult = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Struct({
    ...ClaudeRequestUsage.fields,
    /** The turn's final model request; the top-level fields sum every request. */
    iterations: Schema.optional(Schema.Array(ClaudeRequestUsage))
  }))
})

const decodeAuthStatus = Schema.decodeUnknownOption(ClaudeAuthStatus)
const decodeStreamDelta = Schema.decodeUnknownOption(ClaudeStreamDelta)
const decodeResult = Schema.decodeUnknownOption(ClaudeResult)

export interface ClaudeCliProviderOptions {
  readonly binary?: string
  readonly cwd?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly checkAuth?: (signal?: AbortSignal) => Promise<void>
  readonly startToolRelay?: typeof startClaudeCliToolRelay
  readonly spawnProcess?: typeof spawn
}

const subscriptionEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const sanitized = { ...environment }
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY"
  ]) delete sanitized[key]
  return sanitized
}

export const checkClaudeSubscription = async (
  binary: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> => {
  let stdout: string
  try {
    stdout = await execFileText(binary, ["auth", "status"], { env: environment, timeout: 5_000, signal })
  } catch {
    throw new Error("Claude CLI is not authenticated with a subscription")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error("Claude CLI returned an invalid authentication status")
  }
  const status = Option.getOrNull(decodeAuthStatus(parsed))
  if (status === null || !status.loggedIn) throw new Error("Claude CLI is not authenticated with a subscription")
}

export const verifyLocalClaudeSubscription = (
  options: Pick<ClaudeCliProviderOptions, "binary" | "environment"> & {
    readonly signal?: AbortSignal
  } = {}
): Promise<void> => {
  const binary = options.binary ?? process.env.JINGLER_CLAUDE_BINARY ?? "claude"
  return checkClaudeSubscription(
    binary,
    subscriptionEnvironment(options.environment ?? process.env),
    options.signal
  )
}

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

/**
 * pi reads a message's usage as the context it occupies (and compacts on it),
 * so it must describe the LAST request, not the sum over the CLI's whole turn —
 * that sum grows with every tool call and reported millions of tokens for a
 * session a fraction that size. An older CLI without `iterations` falls back
 * to the sum.
 */
const usageFrom = (result: typeof ClaudeResult.Type): Usage => {
  const usage = result.usage?.iterations?.at(-1) ?? result.usage
  const input = usage?.input_tokens ?? 0
  const output = usage?.output_tokens ?? 0
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

const partialMessage = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: zeroUsage(),
  stopReason: "pending",
  timestamp: Date.now()
})

type ClaudeInputContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image"
      readonly source: {
        readonly type: "base64"
        readonly media_type: string
        readonly data: string
      }
    }

// The three Pi message variants are clearer serialized together than behind dispatch helpers.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol serialization stays auditable here.
function transcriptContent(context: Context): ReadonlyArray<ClaudeInputContent> {
  const content: Array<ClaudeInputContent> = []
  for (const message of context.messages) {
    if (message.role === "user") {
      content.push({ type: "text", text: "<jingler-message role=\"user\">" })
      if (typeof message.content === "string") content.push({ type: "text", text: message.content })
      else {
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text })
          else content.push({
            type: "image",
            source: { type: "base64", media_type: part.mimeType, data: part.data }
          })
        }
      }
      content.push({ type: "text", text: "</jingler-message>" })
      continue
    }
    if (message.role === "toolResult") {
      const output = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      content.push({
        type: "text",
        text: `<jingler-tool-result id=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} error=${JSON.stringify(message.isError)}>\n${output}\n</jingler-tool-result>`
      })
      continue
    }
    content.push({ type: "text", text: "<jingler-message role=\"assistant\">" })
    for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
      else if (part.type === "thinking") continue
      else content.push({
        type: "text",
        text: `<jingler-tool-call id=${JSON.stringify(part.id)} name=${JSON.stringify(part.name)}>\n${JSON.stringify(part.arguments)}\n</jingler-tool-call>`
      })
    }
    content.push({ type: "text", text: "</jingler-message>" })
  }
  return content
}

const inputLine = (context: Context): string => JSON.stringify({
  type: "user",
  message: { role: "user", content: transcriptContent(context) },
  parent_tool_use_id: null,
  session_id: randomUUID()
})

const effortArgs = (reasoning: SimpleStreamOptions["reasoning"]): ReadonlyArray<string> => {
  if (reasoning === undefined) return []
  if (reasoning === "minimal" || reasoning === "low") return ["--effort", "low"]
  if (reasoning === "medium") return ["--effort", "medium"]
  return ["--effort", "high"]
}

const systemPrompt = (context: Context): string => {
  const prompt = context.systemPrompt ?? ""
  if (!context.tools?.some(({ name }) => name === "mcp_search")) return prompt
  const policy = "Jingler's configured MCP services are available through mcp_search and mcp_call. When the user asks to use or inspect a named service, call mcp_search for that service before taking other action, then use mcp_call as needed. Never claim to have used a service without a successful tool result."
  return prompt.length === 0 ? policy : `${prompt}\n\n${policy}`
}

export const claudeCliArguments = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  mcpConfigPath: string
): ReadonlyArray<string> => [
  "-p",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources", "",
  "--disable-slash-commands",
  "--no-chrome",
  "--strict-mcp-config",
  "--mcp-config", mcpConfigPath,
  "--tools", "",
  "--allowedTools", "mcp__jingler__*",
  "--model", model.id,
  "--system-prompt", systemPrompt(context),
  ...effortArgs(options.reasoning)
]

const appendText = (
  partial: AssistantMessage,
  type: "text" | "thinking",
  delta: string
): { readonly index: number; readonly start: boolean } => {
  const last = partial.content.at(-1)
  if (last?.type === type) {
    if (type === "text") (last as TextContent).text += delta
    else (last as ThinkingContent).thinking += delta
    return { index: partial.content.length - 1, start: false }
  }
  partial.content.push(
    type === "text"
      ? { type: "text", text: delta }
      : { type: "thinking", thinking: delta }
  )
  return { index: partial.content.length - 1, start: true }
}

type OpenContent = { readonly type: "text" | "thinking"; readonly index: number }
type DecodedClaudeLine =
  | { readonly kind: "delta"; readonly value: typeof ClaudeStreamDelta.Type }
  | { readonly kind: "result"; readonly value: typeof ClaudeResult.Type }
  | { readonly kind: "ignored" }

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null

const isCriticalClaudeRecord = (value: unknown): boolean => {
  const record = recordOf(value)
  if (record?.type === "result") return true
  const event = recordOf(record?.event)
  if (record?.type !== "stream_event" || event?.type !== "content_block_delta") return false
  const delta = recordOf(event.delta)
  return delta?.type === "text_delta" || delta?.type === "thinking_delta"
}

const decodeClaudeLine = (line: string): DecodedClaudeLine => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Claude CLI emitted malformed stream JSON")
  }
  const delta = Option.getOrNull(decodeStreamDelta(value))
  if (delta !== null) return { kind: "delta", value: delta }
  const result = Option.getOrNull(decodeResult(value))
  if (result !== null) return { kind: "result", value: result }
  if (isCriticalClaudeRecord(value)) {
    throw new Error("Claude CLI emitted a malformed critical stream event")
  }
  return { kind: "ignored" }
}

const closeContentEvent = (
  partial: AssistantMessage,
  open: OpenContent | null
): AssistantMessageEvent | null => {
  if (open === null) return null
  return open.type === "text"
    ? {
        type: "text_end",
        contentIndex: open.index,
        content: (partial.content[open.index] as TextContent).text,
        partial: { ...partial }
      }
    : {
        type: "thinking_end",
        contentIndex: open.index,
        content: (partial.content[open.index] as ThinkingContent).thinking,
        partial: { ...partial }
      }
}

const deltaEvents = (
  partial: AssistantMessage,
  open: OpenContent | null,
  delta: typeof ClaudeStreamDelta.Type
): { readonly events: ReadonlyArray<AssistantMessageEvent>; readonly open: OpenContent } => {
  const type = delta.event.delta.type === "text_delta" ? "text" : "thinking"
  const text = delta.event.delta.type === "text_delta"
    ? delta.event.delta.text
    : delta.event.delta.thinking
  const appended = appendText(partial, type, text)
  const events: AssistantMessageEvent[] = []
  if (appended.start) {
    const closed = closeContentEvent(partial, open)
    if (closed !== null) events.push(closed)
    events.push(type === "text"
      ? { type: "text_start", contentIndex: appended.index, partial: { ...partial } }
      : { type: "thinking_start", contentIndex: appended.index, partial: { ...partial } })
  }
  events.push(type === "text"
    ? { type: "text_delta", contentIndex: appended.index, delta: text, partial: { ...partial } }
    : { type: "thinking_delta", contentIndex: appended.index, delta: text, partial: { ...partial } })
  return {
    events,
    open: appended.start ? { type, index: appended.index } : (open ?? { type, index: appended.index })
  }
}

const toolEvents = (
  partial: AssistantMessage,
  call: RelayedToolCall
): ReadonlyArray<AssistantMessageEvent> => {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments
  }
  const index = partial.content.length
  partial.content.push(toolCall)
  return [
    { type: "toolcall_start", contentIndex: index, partial: { ...partial } },
    {
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(call.arguments),
      partial: { ...partial }
    },
    { type: "toolcall_end", contentIndex: index, toolCall, partial: { ...partial } }
  ]
}

interface ClaudeOutputState {
  result: typeof ClaudeResult.Type | null
  open: OpenContent | null
}

async function* streamClaudeOutput(
  child: ChildProcessWithoutNullStreams,
  partial: AssistantMessage,
  state: ClaudeOutputState
): AsyncGenerator<AssistantMessageEvent> {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    const decoded = decodeClaudeLine(line)
    if (decoded.kind === "result") {
      state.result = decoded.value
      return
    }
    if (decoded.kind !== "delta") continue
    const next = deltaEvents(partial, state.open, decoded.value)
    state.open = next.open
    for (const event of next.events) yield event
  }
}

const terminalEvents = (
  partial: AssistantMessage,
  call: RelayedToolCall | null,
  result: typeof ClaudeResult.Type | null,
  aborted: boolean,
  stderr: string
): ReadonlyArray<AssistantMessageEvent> => {
  if (call !== null) {
    partial.stopReason = "toolUse"
    return [
      ...toolEvents(partial, call),
      { type: "done", reason: "toolUse", message: { ...partial } }
    ]
  }
  if (aborted) throw new Error("Claude CLI request was aborted")
  if (result === null) throw new Error(stderr.trim() || "Claude CLI exited without a result")
  if (result.is_error) throw new Error(result.result ?? `Claude CLI failed: ${result.subtype}`)
  partial.usage = usageFrom(result)
  partial.stopReason = "stop"
  return [{ type: "done", reason: "stop", message: { ...partial } }]
}

const terminateProcess = async (
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>
): Promise<void> => {
  if (!child.stdin.writableEnded) child.stdin.end()
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGINT")
  const exited = await Promise.race([
    closed.then(() => true, () => true),
    delay(2_000).then(() => false)
  ])
  if (exited || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGKILL")
  await Promise.race([closed.catch(() => undefined), delay(1_000)])
}

// This is one state machine over child-process, JSONL, MCP relay, and abort events.
/* oxlint-disable complexity -- this state machine keeps cleanup ordering visible. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: splitting it would hide ordering constraints.
async function* runClaudeCli(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  providerOptions: ClaudeCliProviderOptions
): AsyncGenerator<AssistantMessageEvent> {
  const partial = partialMessage(model)
  yield { type: "start", partial: { ...partial } }
  const binary = providerOptions.binary ?? process.env.JINGLER_CLAUDE_BINARY ?? "claude"
  const environment = subscriptionEnvironment(providerOptions.environment ?? process.env)
  const output: ClaudeOutputState = { result: null, open: null }
  let relay: ClaudeCliToolRelay | null = null
  let child: ChildProcessWithoutNullStreams | null = null
  let stderr = ""
  let toolCall: RelayedToolCall | null = null
  let stop = (): Promise<void> => Promise.resolve()
  let onAbort: (() => void) | null = null
  try {
    await (providerOptions.checkAuth ?? ((signal) =>
      checkClaudeSubscription(binary, environment, signal)))(options.signal)
    if (options.signal?.aborted) throw new Error("Claude CLI request was aborted")
    relay = await (providerOptions.startToolRelay ?? startClaudeCliToolRelay)(context.tools ?? [])
    if (options.signal?.aborted) throw new Error("Claude CLI request was aborted")
    child = trackChild((providerOptions.spawnProcess ?? spawn)(
      binary,
      [...claudeCliArguments(model, context, options, relay.mcpConfigPath)],
      { cwd: providerOptions.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] }
    ))
    const processClosed = new Promise<void>((resolve, reject) => {
      child?.once("close", () => resolve())
      child?.once("error", reject)
    })
    let termination: Promise<void> | null = null
    stop = () => termination ??= terminateProcess(child!, processClosed)
    const captured = relay.toolCall.then((call) => {
      toolCall = call
      return stop()
    })
    child.stdin.on("error", () => undefined)
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    onAbort = () => {
      void stop()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    if (!child.stdin.writableEnded) child.stdin.end(`${inputLine(context)}\n`)
    for await (const event of streamClaudeOutput(child, partial, output)) yield event
    await Promise.race([captured, processClosed])
    const closed = closeContentEvent(partial, output.open)
    if (closed !== null) yield closed
    for (const event of terminalEvents(
      partial,
      toolCall,
      output.result,
      options.signal?.aborted ?? false,
      stderr
    )) yield event
  } catch (cause) {
    partial.stopReason = options.signal?.aborted ? "aborted" : "error"
    partial.errorMessage = cause instanceof Error ? cause.message : "Claude CLI request failed"
    yield { type: "error", reason: partial.stopReason, error: { ...partial } }
  } finally {
    if (onAbort !== null) options.signal?.removeEventListener("abort", onAbort)
    await stop()
    await relay?.close()
  }
}
/* oxlint-enable complexity */

async function* runClaudeCliOrAbort(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  providerOptions: ClaudeCliProviderOptions
): AsyncGenerator<AssistantMessageEvent> {
  if (!options.signal?.aborted) {
    yield* runClaudeCli(model, context, options, providerOptions)
    return
  }
  const partial = partialMessage(model)
  partial.stopReason = "aborted"
  partial.errorMessage = "Claude CLI request was aborted"
  yield { type: "start", partial: { ...partial } }
  yield { type: "error", reason: "aborted", error: { ...partial } }
}

export const createClaudeCliStreamSimple = (
  providerOptions: ClaudeCliProviderOptions = {}
) => (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {}
) => lazyStream(
  model,
  async () => runClaudeCliOrAbort(model, context, options, providerOptions)
)
