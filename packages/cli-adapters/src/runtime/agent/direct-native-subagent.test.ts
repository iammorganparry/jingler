import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderId,
  ProviderModelId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  inactiveRuntimeActivity,
  type AgentRuntimeContext,
  type AgentRuntimeShape
} from "./agent-runtime.js"
import { makeDirectNativeSubagentDelegate } from "./direct-native-subagent.js"

const spec = (runtimeId: "codex" | "opencode"): AgentRunSpec => ({
  runId: "parent-run",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId,
  endpointId: AgentEndpointId.make(`desktop:${runtimeId}:default`),
  providerId: ProviderId.make(runtimeId === "codex" ? "openai" : "local"),
  modelId: ProviderModelId.make(`${runtimeId}/parent-model`),
  role: "conversation",
  mode: "auto",
  cwd: "/workspace",
  prompt: "parent",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  }
})

const context = (recordUsage = vi.fn(() => Effect.void)): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  recordUsage,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([])
})

const runtime = (seen: AgentRunSpec[]): AgentRuntimeShape => ({
  run: (child) => {
    seen.push(child)
    return Stream.make(
      { _tag: "Started" as const, sessionId: "child-session", model: child.modelId },
      { _tag: "Assistant" as const, text: `${child.runtimeId} child` },
      { _tag: "Done" as const, tokens: 12, costUsd: child.runtimeId === "opencode" ? 0.04 : 0 }
    )
  },
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  controlSubagent: () => Effect.die("unused"),
  decidePlanReview: () => Effect.die("unused"),
  subagentFleetSnapshot: () => Effect.die("unused"),
  subagentTranscript: () => Effect.die("unused")
})

const request = (agent = "researcher") => ({
  requestId: "request-1",
  ownerRunId: "parent-run",
  nodeId: "node-1",
  agent,
  task: "Inspect the code",
  context: "fresh" as const,
  cwd: "/workspace",
  result: { kind: "text" as const }
})

describe("direct native foreground subagents", () => {
  it.each(["codex", "opencode"] as const)("runs a fresh bounded %s child without PI credentials", async (runtimeId) => {
    const seen: AgentRunSpec[] = []
    const recordUsage = vi.fn(() => Effect.void)
    const parent = spec(runtimeId)
    const delegate = makeDirectNativeSubagentDelegate({
      spec: parent,
      context: context(recordUsage),
      models: { researcher: ProviderModelId.make(`${runtimeId}/cheap-model`) },
      makeRuntime: () => runtime(seen)
    })
    const result = await delegate(request(), new AbortController().signal)

    expect(result).toMatchObject({
      status: "completed",
      result: { kind: "text", text: `${runtimeId} child` }
    })
    expect(seen[0]).toMatchObject({
      runtimeId,
      modelId: `${runtimeId}/cheap-model`,
      role: "review",
      mode: "read-only",
      continuation: null,
      prompt: "Inspect the code"
    })
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "parent-run",
      runtimeId,
      totalTokens: 12,
      costUsd: runtimeId === "opencode" ? 0.04 : null
    }))
  })

  it("forces writable OpenCode children read-only when the parent is in plan mode", async () => {
    const seen: AgentRunSpec[] = []
    const delegate = makeDirectNativeSubagentDelegate({
      spec: { ...spec("opencode"), mode: "plan" },
      context: context(),
      models: {},
      makeRuntime: () => runtime(seen)
    })
    await delegate(request("worker"), new AbortController().signal)
    expect(seen[0]).toMatchObject({ role: "review", mode: "read-only" })
  })

  it("records a cancelled child when the parent aborts", async () => {
    const recordUsage = vi.fn(() => Effect.void)
    const delegate = makeDirectNativeSubagentDelegate({
      spec: spec("opencode"),
      context: context(recordUsage),
      models: {},
      makeRuntime: () => ({
        ...runtime([]),
        run: () => Stream.never
      })
    })
    const controller = new AbortController()
    const pending = delegate(request(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "cancelled",
      runtimeId: "opencode"
    }))
  })

  it("rejects nested fanout before launching a native child", async () => {
    const makeRuntime = vi.fn(() => runtime([]))
    const delegate = makeDirectNativeSubagentDelegate({
      spec: spec("codex"),
      context: context(),
      models: {},
      makeRuntime
    })
    await expect(delegate(request("fanout"), new AbortController().signal))
      .rejects.toThrow("Nested native fanout")
    expect(makeRuntime).not.toHaveBeenCalled()
  })
})
