import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderId,
  ProviderModelId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { NativeSubagentDelegate } from "./native-subagent-tool.js"
import { registerNativeSubagentTool } from "./native-subagent-tool.js"
import type { PiSubagentAsyncDelegate } from "./pi-subagent-rpc.js"
import { ToolRegistry } from "../tools/tool-registry.js"

const spec: AgentRunSpec = {
  runId: "native-run",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "claude",
  endpointId: AgentEndpointId.make("desktop:claude:default"),
  providerId: ProviderId.make("anthropic"),
  modelId: ProviderModelId.make("anthropic/sonnet"),
  role: "conversation",
  mode: "auto",
  cwd: "/workspace",
  prompt: "delegate",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  }
}

describe("native PI-backed subagent tool", () => {
  it("delegates one configured role through the PI host and returns terminal usage", async () => {
    const delegateSubagent = vi.fn<NativeSubagentDelegate>(async (request, _signal, onUpdate) => {
      onUpdate?.({
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        currentTool: "web_search"
      })
      return {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        runId: "child-1",
        agent: request.agent,
        model: "anthropic/haiku",
        result: { kind: "text", text: "researched" },
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
          toolCalls: 1,
          durationMs: 25
        }
      }
    })
    const registry = new ToolRegistry()
    registerNativeSubagentTool(registry, spec, delegateSubagent)
    const result = await Effect.runPromise(registry.execute({
      id: "subagent",
      arguments: { agent: "researcher", task: "Research the current API" },
      role: "conversation",
      mode: "auto"
    }))

    expect(result).toMatchObject({
      status: "success",
      value: { runId: "child-1", agent: "researcher", result: "researched" }
    })
    expect(delegateSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRunId: "native-run",
        agent: "researcher",
        task: "Research the current API",
        context: "fresh"
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
  })

  const asyncTool = (
    spawnSubagent: PiSubagentAsyncDelegate,
    asyncAgentNames?: Readonly<Record<string, string>>
  ) => {
    const registry = new ToolRegistry()
    registerNativeSubagentTool(
      registry,
      spec,
      vi.fn<NativeSubagentDelegate>(),
      spawnSubagent,
      asyncAgentNames
    )
    return registry
  }

  it("starts an async single child through PI RPC", async () => {
    const spawnSubagent = vi.fn<PiSubagentAsyncDelegate>(async () => ({
      runId: "async-1",
      asyncDir: "/tmp/async-1",
      text: "started"
    }))
    const result = await Effect.runPromise(asyncTool(spawnSubagent).execute({
      id: "subagent",
      arguments: {
        async: true,
        agent: "worker",
        task: "Implement the bounded change",
        context: "fork"
      },
      role: "conversation",
      mode: "auto"
    }))
    expect(result).toMatchObject({
      status: "success",
      value: { status: "running", runId: "async-1", asyncDir: "/tmp/async-1" }
    })
    expect(spawnSubagent).toHaveBeenCalledWith({
      agent: "worker",
      task: "Implement the bounded change",
      cwd: "/workspace",
      context: "fork"
    }, expect.any(AbortSignal))
  })

  it("routes a native async role through its session-owned external profile", async () => {
    const spawnSubagent = vi.fn<PiSubagentAsyncDelegate>(async () => ({
      runId: "async-native",
      asyncDir: "/tmp/async-native",
      text: "started"
    }))
    await Effect.runPromise(asyncTool(spawnSubagent, {
      worker: "jingler-codex-binding-worker"
    }).execute({
      id: "subagent",
      arguments: { async: true, agent: "worker", task: "Implement it" },
      role: "conversation",
      mode: "auto"
    }))
    expect(spawnSubagent).toHaveBeenCalledWith(expect.objectContaining({
      agent: "jingler-codex-binding-worker"
    }), expect.any(AbortSignal))
  })

  it.each(["parallel", "chain"] as const)("generates a bounded %s workflow script", async (mode) => {
    const spawnSubagent = vi.fn<PiSubagentAsyncDelegate>(async () => ({
      runId: `async-${mode}`,
      asyncDir: `/tmp/async-${mode}`,
      text: "started"
    }))
    await Effect.runPromise(asyncTool(spawnSubagent).execute({
      id: "subagent",
      arguments: {
        async: true,
        workflow: {
          mode,
          tasks: [
            { agent: "scout", task: "Inspect the \"API\"" },
            { agent: "reviewer", task: "Review the result" }
          ]
        }
      },
      role: "conversation",
      mode: "auto"
    }))
    const request = spawnSubagent.mock.calls[0]?.[0]
    expect(request?.workflowScript).toContain(mode === "parallel" ? "runs.all" : "Previous result")
    expect(request?.workflowScript).toContain("step-1")
    expect(request?.workflowScript).toContain("step-2")
    expect(request?.workflowScript).not.toContain("workflowScriptPath")
  })

  it("rejects workflows above the eight-child bound", async () => {
    const spawnSubagent = vi.fn<PiSubagentAsyncDelegate>()
    const result = await Effect.runPromise(asyncTool(spawnSubagent).execute({
      id: "subagent",
      arguments: {
        async: true,
        workflow: {
          mode: "parallel",
          tasks: Array.from({ length: 9 }, (_, index) => ({
            agent: "reviewer",
            task: `Review ${index}`
          }))
        }
      },
      role: "conversation",
      mode: "auto"
    }))
    expect(result.status).toBe("error")
    expect(spawnSubagent).not.toHaveBeenCalled()
  })
})
