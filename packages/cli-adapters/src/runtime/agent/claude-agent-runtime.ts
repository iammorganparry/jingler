import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  nativeCliEndpointTargets,
  type AgentRunSpec,
  type StreamEvent
} from "@jingler/core"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import { isRecord } from "effect/Predicate"
import {
  AgentRuntimeError,
  type AgentRuntimeContext,
  type AgentRuntimeRegistration,
  type AgentRuntimeShape
} from "./agent-runtime.js"

import { trackChild } from "../../child-registry.js"
import { recordClaudeCliRateLimits } from "../providers/claude-cli-rate-limits.js"
import type { RegistryMcpRelay } from "../providers/registry-mcp-relay.js"
import { claudeCliEnvironment } from "../providers/claude-cli-environment.js"
import { ClaudeRequestUsage, ClaudeTurnUsage, claudeUsageTokens } from "../providers/claude-cli-usage.js"
import { prepareNativeRuntimeTools, type NativeRuntimeToolsOptions } from "./native-runtime-tools.js"

export interface ClaudeAgentRuntimeOptions extends NativeRuntimeToolsOptions {
  readonly binary?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnProcess?: (binary: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
  readonly checkAuth?: (signal?: AbortSignal) => Promise<void>
}

const modelName = (modelId: string): string =>
  modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId

const reasoningArgs = (reasoning: AgentRunSpec["reasoning"]): ReadonlyArray<string> => {
  if (!reasoning?.enabled) return []
  const effort = reasoning.effort === "minimal"
    ? "low"
    : reasoning.effort === "xhigh"
      ? "max"
      : reasoning.effort
  return effort === undefined ? [] : ["--effort", effort]
}

const permissionArgs = (mode: AgentRunSpec["mode"]): ReadonlyArray<string> => {
  switch (mode) {
    case "accept-edits":
      return ["--permission-mode", "acceptEdits", "--permission-prompts", "none"]
    case "auto":
      return ["--permission-mode", "auto", "--permission-prompts", "none"]
    case "plan":
    case "read-only":
      return ["--permission-mode", "plan", "--permission-prompts", "none"]
    case "ask":
      return ["--permission-mode", "manual", "--permission-prompts", "none"]
  }
}

export const claudeAgentArguments = (
  spec: AgentRunSpec,
  sessionId: string,
  mcpConfigPath?: string,
  systemPrompt?: string
): ReadonlyArray<string> => [
  "-p",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--model", modelName(spec.modelId),
  "--setting-sources", "",
  "--disable-slash-commands",
  "--system-prompt-snapshot", "off",
  ...(systemPrompt === undefined ? [] : ["--system-prompt", systemPrompt]),
  "--no-chrome",
  "--tools", "",
  "--allowedTools", "mcp__jingler__*",
  "--strict-mcp-config",
  ...(mcpConfigPath === undefined ? [] : ["--mcp-config", mcpConfigPath]),
  ...permissionArgs(spec.mode),
  ...reasoningArgs(spec.reasoning),
  ...(spec.continuation === null
    ? ["--session-id", sessionId]
    : ["--resume", spec.continuation.id])
]

const transcriptText = (spec: AgentRunSpec): string => {
  if (spec.continuation !== null) return spec.prompt
  const messages = spec.seed?.messages ?? spec.priorMessages
  if (messages.length === 0) return spec.prompt
  const transcript = messages.map((message) => {
    const text = message.parts.flatMap((part) => {
      if (part._tag === "Text") return [part.text]
      if (part._tag === "Tool") return [part.tool.output ?? ""]
      return []
    }).filter(Boolean).join("\n")
    return `<jingler-message role=${JSON.stringify(message.role)}>\n${text}\n</jingler-message>`
  }).join("\n")
  return `${transcript}\n<jingler-message role="user">\n${spec.prompt}\n</jingler-message>`
}

const inputLine = (spec: AgentRunSpec, sessionId: string): string => JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: transcriptText(spec) },
      ...(spec.images ?? []).map((image) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.data
        }
      }))
    ]
  },
  parent_tool_use_id: null,
  session_id: sessionId
})

const invalidContinuation =
  /no conversation found|session[^\n]*not found|invalid[^\n]*session/iu

const decodeRequestUsage = Schema.decodeUnknownSync(ClaudeRequestUsage)
const decodeTurnUsage = Schema.decodeUnknownSync(ClaudeTurnUsage)

const usageEvent = (usage: ClaudeRequestUsage): StreamEvent => ({
  _tag: "Usage",
  tokens: claudeUsageTokens(usage)
})

const contentEvents = (value: unknown): ReadonlyArray<StreamEvent> => {
  if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) return []
  const { content } = value.message
  if (!Array.isArray(content)) return []
  return content.flatMap((part): ReadonlyArray<StreamEvent> => {
    if (!isRecord(part)) return []
    if (part.type === "thinking" && typeof part.thinking === "string") {
      return [{ _tag: "Thinking", text: part.thinking, seconds: null, done: true }]
    }
    if (
      part.type === "tool_use" &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      !part.name.startsWith("mcp__jingler__")
    ) {
      return [{ _tag: "ToolStart", id: part.id, name: part.name, target: null }]
    }
    return []
  })
}

const streamEvents = (value: Record<string, unknown>): ReadonlyArray<StreamEvent> => {
  if (
    !isRecord(value.event) ||
    value.event.type !== "content_block_delta" ||
    !isRecord(value.event.delta)
  ) return []
  const { delta } = value.event
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return [{ _tag: "Assistant", text: delta.text }]
  }
  return delta.type === "thinking_delta" && typeof delta.thinking === "string"
    ? [{ _tag: "Thinking", text: delta.thinking, seconds: null, done: false }]
    : []
}

const decodeLine = (line: string): ReadonlyArray<StreamEvent> => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Claude CLI emitted malformed stream JSON")
  }
  if (!isRecord(value)) return []
  // The subscription's usage windows ride along with every turn; they feed the
  // Usage panel and never the conversation.
  if (recordClaudeCliRateLimits(value)) return []
  if (value.type === "stream_event") return streamEvents(value)
  if (value.type === "assistant") {
    const usage = value.parent_tool_use_id == null && isRecord(value.message) && isRecord(value.message.usage)
      ? [usageEvent(decodeRequestUsage(value.message.usage))]
      : []
    return [...contentEvents(value), ...usage]
  }
  if (value.type !== "result") return []
  if (typeof value.is_error !== "boolean") {
    throw new Error("Claude CLI emitted a malformed result")
  }
  if (value.is_error) {
    return [{
      _tag: "Failed",
      message: typeof value.result === "string" ? value.result : "Claude CLI failed"
    }]
  }
  if (!isRecord(value.usage)) throw new Error("Claude CLI result is missing usage")
  const usage = decodeTurnUsage(value.usage)
  /**
   * The usage of the turn's LAST model request — the one that says how full the
   * context window is now.
   *
   * `result.usage` is the sum over every request in the turn, so a turn of 30
   * tool calls re-reading a 100k cached prompt reported ~3M "context" and tripped
   * compaction on a session a fraction that size. The CLI reports the final
   * request under `usage.iterations`. Without it, use assistant-message usage,
   * never the cumulative result: repeated cached reads are spend, not occupancy.
   */
  const last = usage.iterations?.at(-1)
  return [
    ...(last === undefined ? [] : [usageEvent(last)]),
    // Done carries the turn's spend, so it keeps the summed usage.
    { _tag: "Done", tokens: claudeUsageTokens(usage), costUsd: 0 }
  ]
}

const stopProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid === undefined) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 250)
    child.once("close", () => { clearTimeout(timer); resolve() })
    child.kill("SIGINT")
  })
}

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode)
    child.once("error", reject)
    child.once("close", resolve)
  })

const maxProtocolLineBytes = 4_194_304
const assertProtocolLineBound = (line: string): void => {
  if (Buffer.byteLength(line) > maxProtocolLineBytes) {
    throw new Error("Claude CLI protocol line exceeds output bound")
  }
}

async function* boundedLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<string> {
  child.stdout.setEncoding("utf8")
  let buffer = ""
  for await (const chunk of child.stdout) {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      const line = newline < 0 ? buffer : buffer.slice(0, newline)
      assertProtocolLineBound(line)
      if (newline < 0) break
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) yield line
    }
  }
  if (buffer.length > 0) yield buffer
}

const protocolLine = (line: string): boolean => {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) &&
      ["assistant", "result", "stream_event", "system", "user", "rate_limit_event", "tool_progress", "tool_use_summary"].includes(String(value.type))
  } catch {
    return false
  }
}

const trackTerminal = (state: { terminal: boolean }, event: StreamEvent): void => {
  if (event._tag !== "Done" && event._tag !== "Failed") return
  if (state.terminal) throw new Error("Claude CLI emitted multiple results")
  state.terminal = true
}

async function* claudeOutput(
  child: ChildProcessWithoutNullStreams,
  secret: string,
  state: { terminal: boolean; started: boolean },
  started: StreamEvent,
  onTerminal: () => void
): AsyncGenerator<StreamEvent> {
  for await (const raw of boundedLines(child)) {
    const line = raw.replaceAll(secret, "[redacted]")
    if (!protocolLine(line)) throw new Error("Claude CLI emitted an invalid protocol record")
    const events = decodeLine(line)
    if (!state.started) {
      state.started = true
      yield started
    }
    if (state.terminal) throw new Error("Claude CLI emitted output after its result")
    for (const event of events) {
      trackTerminal(state, event)
      if (state.terminal) onTerminal()
      yield event
    }
  }
}

const reserveClaudeSession = async (reserved: Set<string>, sessionId: string, scope: Scope.CloseableScope) => {
  if (reserved.has(sessionId)) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw new Error("Claude session is already active")
  }
  reserved.add(sessionId)
}

async function* runClaude(
  spec: AgentRunSpec,
  options: ClaudeAgentRuntimeOptions,
  active: Map<string, ChildProcessWithoutNullStreams>,
  reserved: Set<string>,
  context: AgentRuntimeContext,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const sessionId = spec.continuation?.id ?? randomUUID()
  const binary = options.binary ?? process.env.JINGLER_CLAUDE_BINARY ?? "claude"
  const environment = claudeCliEnvironment(options.environment ?? process.env)
  const scope = await Effect.runPromise(Scope.make())
  await reserveClaudeSession(reserved, sessionId, scope)
  let relay: RegistryMcpRelay | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let onAbort = () => {}
  try {
    await options.checkAuth?.(signal)
    const prepared = await Effect.runPromise(
      prepareNativeRuntimeTools(spec, context, options).pipe(Scope.extend(scope)),
      { signal }
    )
    relay = prepared.relay
    signal.throwIfAborted()
    child = trackChild((options.spawnProcess ?? spawn)(
      binary,
      [...claudeAgentArguments(spec, sessionId, relay.mcpConfigPath, prepared.systemPrompt)],
      { cwd: spec.cwd, env: { ...environment, ...relay.environment }, stdio: ["pipe", "pipe", "pipe"] }
    ))
    const spawned = child
    onAbort = () => { void stopProcess(spawned) }
    signal.addEventListener("abort", onAbort, { once: true })
    await new Promise<void>((resolve, reject) => {
      spawned.once("spawn", resolve)
      spawned.once("error", reject)
    })
    active.set(sessionId, child)
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(`${inputLine(spec, sessionId)}\n`)
    const output = { terminal: false, started: false }
    yield* claudeOutput(
      child,
      relay.environment.JINGLER_TOOL_RELAY_TOKEN!,
      output,
      { _tag: "Started", sessionId, model: spec.modelId },
      // A terminal event wins over an interrupt delivered by its consumer.
      () => { if (active.get(sessionId) === child) active.delete(sessionId) }
    )
    const exitCode = await waitForExit(spawned)
    if (exitCode !== 0) {
      const message = stderr.trim().replaceAll(relay.environment.JINGLER_TOOL_RELAY_TOKEN!, "[redacted]") || `Claude CLI exited with ${exitCode}`
      if (
        spec.continuation !== null &&
        invalidContinuation.test(message)
      ) {
        yield* runClaude({ ...spec, continuation: null }, options, active, reserved, context, signal)
        return
      }
      throw new Error(message)
    }
    if (!output.terminal) throw new Error("Claude CLI exited without a result")
  } finally {
    if (active.get(sessionId) === child) active.delete(sessionId)
    reserved.delete(sessionId)
    signal.removeEventListener("abort", onAbort)
    if (child !== undefined) await stopProcess(child)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

const runtimeError = (cause: unknown): AgentRuntimeError =>
  new AgentRuntimeError({
    reason: "runtime",
    message: cause instanceof Error ? cause.message : "Claude CLI failed",
    cause
  })

const unsupported = (operation: string) => Effect.fail(new AgentRuntimeError({
  reason: "runtime",
  message: `Claude CLI does not support ${operation} through this adapter yet`
}))

const claudeStream = (
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  options: ClaudeAgentRuntimeOptions,
  active: Map<string, ChildProcessWithoutNullStreams>,
  reserved: Set<string>
) => Stream.async<StreamEvent, AgentRuntimeError>((emit) => {
  const controller = new AbortController()
  const completion = (async () => {
    try {
      for await (const event of runClaude(spec, options, active, reserved, context, controller.signal)) {
        await emit.single(event)
      }
      if (!controller.signal.aborted) await emit.end()
    } catch (cause) {
      if (!controller.signal.aborted) await emit.fail(runtimeError(cause))
    }
  })()
  return Effect.promise(async () => {
    controller.abort()
    await completion
  })
})

export const makeClaudeAgentRuntime = (
  options: ClaudeAgentRuntimeOptions = {}
): AgentRuntimeShape => {
  const active = new Map<string, ChildProcessWithoutNullStreams>()
  const reserved = new Set<string>()
  return {
    run: (spec, context) => claudeStream(spec, context, options, active, reserved),
    steer: () => unsupported("steering"),
    interrupt: (continuation) => {
      const child = active.get(continuation.id)
      return child === undefined
        ? unsupported("interrupting an inactive session")
        : Effect.promise(() => stopProcess(child))
    },
    controlSubagent: options.subagentFleet?.controlSubagent ?? (() => unsupported("subagent control")),
    decidePlanReview: () => unsupported("native plan review"),
    subagentFleetSnapshot: options.subagentFleet?.subagentFleetSnapshot ??
      (() => unsupported("subagent fleet snapshots")),
    subagentTranscript: options.subagentFleet?.subagentTranscript ??
      (() => unsupported("subagent transcripts"))
  }
}

export const makeClaudeRuntimeRegistration = (
  options: ClaudeAgentRuntimeOptions = {}
): AgentRuntimeRegistration => ({
  runtimeId: "claude",
  runtime: makeClaudeAgentRuntime(options),
  ownsEndpoint: (endpointId, targetId) =>
    nativeCliEndpointTargets(endpointId, "claude", targetId)
})
