import { AgentEndpointId } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { makeCodexAgentRuntime } from "../codex/runtime.js"
import { makeOpenCodeAgentRuntime } from "../opencode/runtime.js"
import { makeClaudeAgentRuntime } from "./claude-agent-runtime.js"
import type { NativeSubagentFleetHandlers } from "./native-runtime-tools.js"

const snapshot = {
  version: 2 as const,
  parentRuntimeSessionId: "pi-native-parent",
  registryRevision: 1,
  generatedAt: 1,
  totalActive: 1,
  omitted: 0,
  activeCapacity: { used: 1, limit: 4 },
  nodes: []
}

const owner = {
  runtimeId: "claude" as const,
  endpointId: AgentEndpointId.make("desktop:claude:default"),
  targetId: "desktop"
}

const handlers = (): NativeSubagentFleetHandlers => ({
  controlSubagent: vi.fn(() => Effect.succeed({
    version: 2,
    requestId: "control-1",
    runId: "child-1",
    action: "stop",
    acknowledged: true,
    status: "accepted",
    deliveryStatus: "delivered",
    sequence: 1,
    nativeRequestId: null,
    message: "accepted",
    acknowledgedAt: 1
  } as const)),
  subagentFleetSnapshot: vi.fn(() => Effect.succeed(snapshot)),
  subagentTranscript: vi.fn(() => Effect.succeed([]))
})

const control = {
  version: 2 as const,
  requestId: "control-1",
  parentRuntimeSessionId: "pi-native-parent",
  runId: "child-1",
  action: "stop" as const,
  message: null,
  replyTo: null
}

describe("native runtime retained Fleet routing", () => {
  it.each(["claude", "codex", "opencode"] as const)(
    "routes %s Fleet operations through optional shared handlers",
    async (runtimeId) => {
      const subagentFleet = handlers()
      const runtime = runtimeId === "claude"
        ? makeClaudeAgentRuntime({ subagentFleet })
        : runtimeId === "codex"
          ? makeCodexAgentRuntime({ subagentFleet })
          : makeOpenCodeAgentRuntime({ subagentFleet })

      await expect(Effect.runPromise(runtime.subagentFleetSnapshot(
        { ...owner, runtimeId }, "session-1", "chat-1", "pi-native-parent"
      ))).resolves.toEqual(snapshot)
      await expect(Effect.runPromise(runtime.controlSubagent(
        { ...owner, runtimeId }, "session-1", "chat-1", control
      ))).resolves.toMatchObject({ status: "accepted" })
      await expect(Effect.runPromise(runtime.subagentTranscript(
        { ...owner, runtimeId }, "session-1", "chat-1", "pi-native-parent", "child-1"
      ))).resolves.toEqual([])

      expect(subagentFleet.subagentFleetSnapshot).toHaveBeenCalledOnce()
      expect(subagentFleet.controlSubagent).toHaveBeenCalledOnce()
      expect(subagentFleet.subagentTranscript).toHaveBeenCalledOnce()
    }
  )
})
