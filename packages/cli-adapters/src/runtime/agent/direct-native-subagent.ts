import { randomUUID } from "node:crypto"
import type {
  AgentRunSpec,
  ProviderModelId,
  StreamEvent,
  SubagentModelAssignments
} from "@jingler/core"
import { Chunk, Effect, Stream } from "effect"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import type { NativeSubagentDelegate } from "./native-subagent-tool.js"

const READ_ONLY_SUBAGENTS = new Set(["oracle", "researcher", "reviewer", "scout"])

export const directNativeChildSpec = (
  parent: AgentRunSpec,
  agent: string,
  task: string,
  modelId: ProviderModelId,
  childContext: "fresh" | "fork" = "fresh",
  thinking?: string
): AgentRunSpec => {
  const readOnly = READ_ONLY_SUBAGENTS.has(agent) ||
    parent.mode === "plan" || parent.mode === "read-only"
  return {
  ...parent,
  runId: `${parent.runId}:child:${randomUUID()}`,
  sessionId: `${parent.sessionId}:child`,
  role: readOnly ? "review" : "background",
  mode: readOnly ? "read-only" : parent.mode,
  modelId,
  prompt: task,
  priorMessages: childContext === "fork" ? parent.priorMessages : [],
  continuation: null,
  seed: null,
  images: [],
    ...(thinking === undefined
      ? {}
      : thinking === "off"
        ? { reasoning: { enabled: false } }
        : { reasoning: { enabled: true, effort: thinking as NonNullable<AgentRunSpec["reasoning"]>["effort"] } })
  }
}

const childText = (events: ReadonlyArray<StreamEvent>): string =>
  events.flatMap((event) => event._tag === "Assistant" ? [event.text] : []).join("")

function assertSupportedChild(
  child: AgentRunSpec,
  agent: string
): asserts child is AgentRunSpec & { readonly runtimeId: "codex" | "opencode" } {
  if (agent === "fanout") throw new Error("Nested native fanout is unavailable")
  if (child.runtimeId !== "codex" && child.runtimeId !== "opencode") {
    throw new Error("Direct native subagents require Codex or OpenCode")
  }
  if (
    child.runtimeId === "codex" &&
    child.mode !== "auto" &&
    !READ_ONLY_SUBAGENTS.has(agent)
  ) throw new Error("Writable Codex subagents require Auto mode")
}

const collectChildEvents = async (input: {
  readonly runtime: AgentRuntimeShape
  readonly spec: AgentRunSpec
  readonly context: AgentRuntimeContext
  readonly signal: AbortSignal
  readonly onTool: (name: string) => void
}): Promise<ReadonlyArray<StreamEvent>> => Chunk.toReadonlyArray(await Effect.runPromise(
  input.runtime.run(input.spec, input.context).pipe(
    Stream.tap((event) => Effect.sync(() => {
      if (event._tag === "ToolStart") input.onTool(event.name)
    })),
    Stream.runCollect
  ),
  { signal: input.signal }
))

const boundedSignal = (signal: AbortSignal, timeoutMs?: number): AbortSignal =>
  timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

const recordChildUsage = async (input: {
  readonly parent: AgentRunSpec
  readonly child: AgentRunSpec
  readonly context: AgentRuntimeContext
  readonly startedAt: number
  readonly endedAt: number
  readonly outcome: "success" | "error" | "cancelled"
  readonly done?: Extract<StreamEvent, { _tag: "Done" }>
}) => {
  await Effect.runPromise(input.context.recordUsage?.({
    id: `${input.parent.runId}:child:${input.child.runId}`,
    runId: input.child.runId,
    sessionId: input.parent.sessionId,
    chatId: input.parent.chatId,
    parentRunId: input.parent.runId,
    runtimeId: input.child.runtimeId,
    providerId: input.child.providerId ?? null,
    modelId: String(input.child.modelId),
    kind: "child",
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationMs: input.endedAt - input.startedAt,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: input.done?.tokens ?? null,
    costUsd: input.child.runtimeId === "opencode" ? (input.done?.costUsd ?? null) : null,
    toolCalls: null,
    outcome: input.outcome,
    provenance: `${input.child.runtimeId}.foreground-child`
  }) ?? Effect.void)
}

export const makeDirectNativeSubagentDelegate = (input: {
  readonly spec: AgentRunSpec
  readonly context: AgentRuntimeContext
  readonly models: SubagentModelAssignments
  readonly makeRuntime: (runtimeId: "codex" | "opencode") => AgentRuntimeShape
}): NativeSubagentDelegate => async (request, signal, onUpdate) => {
  const childSpec = directNativeChildSpec(
    input.spec,
    request.agent,
    request.task,
    input.models[request.agent as keyof SubagentModelAssignments] ?? input.spec.modelId,
    request.context,
    request.thinking
  )
  assertSupportedChild(childSpec, request.agent)
  const startedAt = Date.now()
  const childSignal = boundedSignal(signal, request.timeoutMs)
  let events: ReadonlyArray<StreamEvent>
  try {
    events = await collectChildEvents({
      runtime: input.makeRuntime(childSpec.runtimeId),
      spec: childSpec,
      context: input.context,
      signal: childSignal,
      onTool: (currentTool) => onUpdate?.({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        currentTool
      })
    })
  } catch (cause) {
    await recordChildUsage({
      parent: input.spec,
      child: childSpec,
      context: input.context,
      startedAt,
      endedAt: Date.now(),
      outcome: childSignal.aborted ? "cancelled" : "error"
    })
    throw cause
  }
  const failure = events.find((event) => event._tag === "Failed")
  const done = events.findLast((event) => event._tag === "Done")
  if (failure?._tag === "Failed" || done?._tag !== "Done") {
    await recordChildUsage({
      parent: input.spec,
      child: childSpec,
      context: input.context,
      startedAt,
      endedAt: Date.now(),
      outcome: "error"
    })
    return {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "failed",
      error: failure?._tag === "Failed" ? failure.message : "Native child ended without usage"
    }
  }
  const endedAt = Date.now()
  await recordChildUsage({
    parent: input.spec,
    child: childSpec,
    context: input.context,
    startedAt,
    endedAt,
    outcome: "success",
    done
  })
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: "completed",
    runId: childSpec.runId,
    agent: request.agent,
    model: String(childSpec.modelId),
    result: { kind: "text", text: childText(events) },
    usage: {
      input: 0,
      output: done.tokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: childSpec.runtimeId === "opencode" ? done.costUsd : 0,
      turns: 1,
      toolCalls: 0,
      durationMs: endedAt - startedAt
    }
  }
}
