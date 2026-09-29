import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  type AgentRunSpec,
  type UsageFact
} from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import type { PiSessionFactory, PiSessionHandle } from "./pi-agent-runtime.js"
import {
  retainedPiFleetHandlers,
  RetainedPiSessionRegistry
} from "./retained-pi-session-registry.js"

const endpointId = AgentEndpointId.make("desktop:pi:native-sidecar")
const spec: AgentRunSpec = {
  runId: "native-parent:delegation-host",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId,
  connectionId: ProviderConnectionId.make("native-sidecar"),
  modelId: ProviderModelId.make("anthropic/sonnet"),
  role: "conversation",
  mode: "auto",
  cwd: "/workspace",
  prompt: "",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: ["subagent"],
    resourceIds: [],
    targetId: "desktop"
  }
}

const context = (recordUsage = vi.fn((_fact: UsageFact) => Effect.void)): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  recordUsage,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([])
})

const snapshot = (active: boolean) => ({
  version: 2 as const,
  parentRuntimeSessionId: "pi-native-parent",
  registryRevision: 1,
  generatedAt: Date.now(),
  totalActive: active ? 1 : 0,
  omitted: 0,
  activeCapacity: { used: active ? 1 : 0, limit: 4 },
  nodes: []
})

const handle = (active: () => boolean, dispose = vi.fn()): PiSessionHandle => ({
  id: "/sessions/native-sidecar.jsonl",
  parentRuntimeSessionId: "pi-native-parent",
  modelId: "anthropic/sonnet",
  contextWindow: 200_000,
  subscribe: () => () => undefined,
  subscribeFleet: () => () => undefined,
  prompt: async () => undefined,
  steer: async () => undefined,
  interrupt: async () => undefined,
  dispose,
  usage: () => ({ costUsd: 0, tokens: 0 }),
  controlSubagent: async (request) => ({
    version: 2,
    requestId: request.requestId,
    runId: request.runId,
    action: request.action,
    acknowledged: request.action === "stop" || request.action === "follow-up",
    status: request.action === "steer" ? "invalid-state" : "accepted",
    deliveryStatus: request.action === "steer" ? "rejected" : "delivered",
    sequence: 1,
    nativeRequestId: null,
    message: request.action === "steer" ? "Live steer is unsupported" : "accepted",
    acknowledgedAt: Date.now()
  }),
  subagentFleetSnapshot: async () => snapshot(active()),
  subagentTranscript: async () => [{
    id: "message-1",
    role: "assistant",
    parts: [{ _tag: "Text", text: "retained transcript" }],
    streaming: false,
    createdAt: "2026-08-10T00:00:00.000Z"
  }]
})

const owner = { runtimeId: "codex" as const, endpointId: AgentEndpointId.make("desktop:codex:default"), targetId: "desktop" }

const control = (action: "stop" | "follow-up" | "steer") => ({
  version: 2 as const,
  requestId: `control-${action}`,
  parentRuntimeSessionId: "pi-native-parent",
  runId: "child-1",
  action,
  message: action === "stop" ? null : "continue",
  replyTo: null
})

describe("retained native PI sidecars", () => {
  it("reuses by chat, rebinds callbacks, owner-checks Fleet operations, and archives transcripts", async () => {
    let childActive = true
    let capturedContext!: AgentRuntimeContext
    const dispose = vi.fn()
    const retainedHandle = handle(() => childActive, dispose)
    const factory: PiSessionFactory = {
      create: vi.fn((_createdSpec, liveContext) => {
        capturedContext = liveContext
        return Effect.succeed(retainedHandle)
      }),
      lockedCapabilityFingerprint: () => Effect.succeed("models:v1")
    }
    const sessions = new RetainedPiSessionRegistry(factory, 5)
    const firstUsage = vi.fn((_fact: UsageFact) => Effect.void)
    const secondUsage = vi.fn((_fact: UsageFact) => Effect.void)

    const first = await Effect.runPromise(sessions.acquireByChat(spec, context(firstUsage), factory))
    await sessions.release(first)
    const second = await Effect.runPromise(sessions.acquireByChat({
      ...spec,
      runId: "native-parent-2:delegation-host",
      continuation: {
        runtimeId: "pi",
        endpointId,
        id: "native-parent-continuation-not-a-pi-id"
      }
    }, context(secondUsage), factory))

    expect(second.handle).toBe(retainedHandle)
    expect(factory.create).toHaveBeenCalledOnce()
    await Effect.runPromise(capturedContext.recordUsage!({} as UsageFact))
    expect(firstUsage).not.toHaveBeenCalled()
    expect(secondUsage).toHaveBeenCalledOnce()

    const fleet = retainedPiFleetHandlers(sessions)
    await expect(Effect.runPromise(fleet.subagentFleetSnapshot(
      owner, "session-1", "chat-1", "pi-native-parent"
    ))).resolves.toMatchObject({ totalActive: 1 })
    await expect(Effect.runPromise(fleet.controlSubagent(
      owner, "session-1", "chat-1", control("stop")
    ))).resolves.toMatchObject({ status: "accepted" })
    await expect(Effect.runPromise(fleet.controlSubagent(
      owner, "session-1", "chat-1", control("steer")
    ))).resolves.toMatchObject({ status: "invalid-state", acknowledged: false })
    await expect(Effect.runPromise(fleet.subagentFleetSnapshot(
      owner, "session-1", "another-chat", "pi-native-parent"
    ))).rejects.toMatchObject({ message: "pi session is not active: pi-native-parent" })

    await sessions.release(second)
    childActive = false
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    await expect(Effect.runPromise(fleet.subagentTranscript(
      owner, "session-1", "chat-1", "pi-native-parent", "child-1"
    ))).resolves.toHaveLength(1)
  })

  it("rejects a changed profile while work is active and rebuilds it only after idle", async () => {
    let childActive = true
    const firstHandle = handle(() => childActive)
    const secondHandle = {
      ...handle(() => false),
      id: "/sessions/rebuilt.jsonl",
      parentRuntimeSessionId: "pi-native-parent-2"
    }
    const firstFactory: PiSessionFactory = {
      create: () => Effect.succeed(firstHandle),
      lockedCapabilityFingerprint: () => Effect.succeed("models:v1")
    }
    const createdSpecs: AgentRunSpec[] = []
    const secondFactory: PiSessionFactory = {
      create: (createdSpec) => {
        createdSpecs.push(createdSpec)
        return Effect.succeed(secondHandle)
      },
      lockedCapabilityFingerprint: () => Effect.succeed("models:v2")
    }
    const sessions = new RetainedPiSessionRegistry(firstFactory, 60_000)
    const first = await Effect.runPromise(sessions.acquireByChat(spec, context(), firstFactory))
    await sessions.release(first)

    await expect(Effect.runPromise(sessions.acquireByChat(spec, context(), secondFactory)))
      .rejects.toMatchObject({
        message: "Native subagent host capabilities changed while detached work is active"
      })
    expect(firstHandle.dispose).not.toHaveBeenCalled()

    childActive = false
    const rebuilt = await Effect.runPromise(sessions.acquireByChat(spec, context(), secondFactory))
    expect(rebuilt.handle).toBe(secondHandle)
    expect(firstHandle.dispose).toHaveBeenCalledOnce()
    expect(createdSpecs[0]?.continuation?.id).toBe("/sessions/native-sidecar.jsonl")
    await sessions.release(rebuilt)
  })
})
