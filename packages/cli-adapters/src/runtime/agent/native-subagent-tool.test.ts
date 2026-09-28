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
})
