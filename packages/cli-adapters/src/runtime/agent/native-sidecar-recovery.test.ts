import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity, type AgentRuntimeContext } from "./agent-runtime.js"
import type { PiSessionFactory, PiSessionHandle } from "./pi-agent-runtime.js"
import { NativeSidecarOwnerStore } from "./native-sidecar-owner-store.js"
import { registerPersistedNativeSidecarRecoveries } from "./native-sidecar-recovery.js"
import { retainedPiFleetHandlers, RetainedPiSessionRegistry } from "./retained-pi-session-registry.js"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const spec: AgentRunSpec = {
  runId: "recovery",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId: AgentEndpointId.make("desktop:pi:native-sidecar"),
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
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  }
}

const context: AgentRuntimeContext = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("deny"),
  askQuestion: () => Effect.succeed([])
}

describe("persisted native sidecar recovery wiring", () => {
  it("loads an owner and lazily reopens only on an owner-checked Fleet request", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-sidecar-recovery-"))
    roots.push(root)
    const store = new NativeSidecarOwnerStore(join(root, "owners.json"))
    await store.put({
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex",
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/sessions/sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent"
    })

    const prompt = vi.fn(async () => undefined)
    const spawnSubagent = vi.fn()
    const recordUsage = vi.fn(() => Effect.void)
    const fleetSnapshot = vi.fn(async () => ({
      version: 2 as const,
      parentRuntimeSessionId: "pi-native-parent",
      registryRevision: 1,
      generatedAt: Date.now(),
      totalActive: 0,
      omitted: 0,
      activeCapacity: { used: 0, limit: 4 },
      nodes: []
    }))
    const recoveredHandle = {
      id: "/sessions/sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      modelId: "anthropic/sonnet",
      contextWindow: 200_000,
      subscribe: () => () => undefined,
      subscribeFleet: () => () => undefined,
      controlSubagent: vi.fn(),
      subagentFleetSnapshot: fleetSnapshot,
      subagentTranscript: vi.fn(async () => []),
      spawnSubagent,
      prompt,
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 0 })
    } satisfies PiSessionHandle
    const create = vi.fn(() => Effect.succeed(recoveredHandle))
    const factory: PiSessionFactory = { create }
    const sessions = new RetainedPiSessionRegistry(factory, 60_000, 0, store)
    registerPersistedNativeSidecarRecoveries(
      sessions,
      await store.list(),
      () => ({ spec, context: { ...context, recordUsage }, factory })
    )

    expect(create).not.toHaveBeenCalled()
    const snapshot = await Effect.runPromise(retainedPiFleetHandlers(sessions).subagentFleetSnapshot(
      {
        runtimeId: "codex",
        endpointId: AgentEndpointId.make("desktop:codex:default"),
        targetId: "desktop"
      },
      "session-1",
      "chat-1",
      "pi-native-parent"
    ))

    expect(snapshot.totalActive).toBe(0)
    expect(create).toHaveBeenCalledOnce()
    expect(prompt).not.toHaveBeenCalled()
    expect(spawnSubagent).not.toHaveBeenCalled()
    expect(recordUsage).not.toHaveBeenCalled()
  })
})
