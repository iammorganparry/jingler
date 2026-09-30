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
import {
  AgentRuntimeError,
  inactiveRuntimeActivity,
  type AgentRuntimeContext
} from "./agent-runtime.js"
import type { PiSessionFactory, PiSessionHandle } from "./pi-agent-runtime.js"
import type { NativeSidecarOwner } from "./native-sidecar-owner-store.js"
import {
  nativeSidecarCapabilityFingerprint,
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

const ownerStore = () => ({
  put: vi.fn(async (value: Omit<NativeSidecarOwner, "version" | "updatedAt">) => ({
    version: 1 as const,
    ...value,
    updatedAt: Date.now()
  })),
  removeExact: vi.fn(async (_value: NativeSidecarOwner) => undefined)
})

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

    const first = await Effect.runPromise(sessions.acquireByChat(
      spec,
      context(firstUsage),
      factory,
      "codex"
    ))
    await sessions.release(first)
    const second = await Effect.runPromise(sessions.acquireByChat({
      ...spec,
      runId: "native-parent-2:delegation-host",
      continuation: {
        runtimeId: "pi",
        endpointId,
        id: "native-parent-continuation-not-a-pi-id"
      }
    }, context(secondUsage), factory, "codex"))

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
    await expect(Effect.runPromise(fleet.subagentFleetSnapshot(
      { ...owner, runtimeId: "opencode" },
      "session-1",
      "chat-1",
      "pi-native-parent"
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

  it("detaches turn-scoped callbacks and browser MCP until the next live acquire", async () => {
    let capturedContext!: AgentRuntimeContext
    const retainedHandle = handle(() => true)
    const factory: PiSessionFactory = {
      create: (_createdSpec, liveContext) => {
        capturedContext = liveContext
        return Effect.succeed(retainedHandle)
      }
    }
    const sessions = new RetainedPiSessionRegistry(factory, 60_000)
    const endedPublish = vi.fn(() => Effect.void)
    const durablePermission = vi.fn(() => Effect.succeed("allow" as const))
    const firstContext: AgentRuntimeContext = {
      ...context(),
      mcp: {
        browser: { name: "browser", url: "http://127.0.0.1:1", headers: {} },
        configured: []
      },
      publishEvent: endedPublish,
      canUseTool: durablePermission
    }
    const first = await Effect.runPromise(sessions.acquireByChat(spec, firstContext, factory))
    await sessions.release(first)

    expect(capturedContext.mcp?.browser).toBeNull()
    await Effect.runPromise(capturedContext.publishEvent({ _tag: "Assistant", text: "late" }))
    expect(endedPublish).not.toHaveBeenCalled()
    await expect(Effect.runPromise(capturedContext.canUseTool({
      toolId: "read",
      risk: "network"
    }))).resolves.toBe("allow")
    expect(durablePermission).toHaveBeenCalledOnce()

    const nextBrowser = { name: "browser", url: "http://127.0.0.1:2", headers: {} }
    const second = await Effect.runPromise(sessions.acquireByChat(spec, {
      ...context(),
      mcp: { browser: nextBrowser, configured: [] }
    }, factory))
    expect(capturedContext.mcp?.browser).toBe(nextBrowser)
    await sessions.release(second)
  })

  it("does not dispose a host reacquired while an awaited snapshot settles", async () => {
    let resolveSnapshot!: (value: ReturnType<typeof snapshot>) => void
    const delayed = new Promise<ReturnType<typeof snapshot>>((resolve) => { resolveSnapshot = resolve })
    const dispose = vi.fn()
    const retainedHandle = {
      ...handle(() => false, dispose),
      subagentFleetSnapshot: vi.fn(() => delayed)
    }
    const factory: PiSessionFactory = { create: () => Effect.succeed(retainedHandle) }
    const sessions = new RetainedPiSessionRegistry(factory, 60_000)
    const first = await Effect.runPromise(sessions.acquireByChat(spec, context(), factory))
    const releasing = sessions.release(first)
    await Promise.resolve()
    const reacquired = await Effect.runPromise(sessions.acquireByChat(spec, context(), factory))
    resolveSnapshot(snapshot(false))
    await releasing
    expect(dispose).not.toHaveBeenCalled()
    await sessions.release(reacquired)
  })

  it("rejects a recovered continuation whose internal parent ownership changed", async () => {
    const dispose = vi.fn()
    const factory: PiSessionFactory = {
      create: () => Effect.succeed(handle(() => false, dispose))
    }
    const sessions = new RetainedPiSessionRegistry(factory, 60_000, 60_000)

    await expect(Effect.runPromise(sessions.recoverByChat({
      version: 1,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex",
      targetId: "device:recovery",
      cwd: "/workspace/recovery",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "different-parent",
      updatedAt: Date.now()
    }, spec, context(), factory))).rejects.toMatchObject({
      message: "Recovered native subagent host ownership does not match"
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(sessions.lookup("different-parent")).toBeUndefined()
  })

  it("persists owner aliases on native sidecar creation and reuse", async () => {
    const retainedHandle = handle(() => true)
    const factory: PiSessionFactory = { create: () => Effect.succeed(retainedHandle) }
    const owners = ownerStore()
    const sessions = new RetainedPiSessionRegistry(factory, 60_000, 60_000, owners)

    const first = await Effect.runPromise(sessions.acquireByChat(
      spec,
      context(),
      factory,
      "codex"
    ))
    await sessions.release(first)
    const second = await Effect.runPromise(sessions.acquireByChat(
      spec,
      context(),
      factory,
      "codex"
    ))

    expect(owners.put).toHaveBeenCalledTimes(2)
    expect(owners.put).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex",
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent"
    })
    await sessions.release(second)
  })

  it("recovers both persisted aliases without prompting, spawning, or recording usage", async () => {
    const prompt = vi.fn(async () => undefined)
    const spawnSubagent = vi.fn()
    const recoveredHandle = {
      ...handle(() => false),
      id: "/sessions/reopened.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      prompt,
      spawnSubagent
    }
    const createdSpecs: AgentRunSpec[] = []
    const factory: PiSessionFactory = {
      create: (createdSpec) => {
        createdSpecs.push(createdSpec)
        return Effect.succeed(recoveredHandle)
      }
    }
    const usage = vi.fn((_fact: UsageFact) => Effect.void)
    const sessions = new RetainedPiSessionRegistry(factory, 60_000, 60_000)
    const recovered = await Effect.runPromise(sessions.recoverByChat({
      version: 1,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "claude",
      targetId: "device:recovery",
      cwd: "/workspace/recovery",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      updatedAt: Date.now()
    }, spec, context(usage), factory))

    expect(recovered.activeTurns).toBe(0)
    expect(createdSpecs[0]?.continuation?.id).toBe("/sessions/native-sidecar.jsonl")
    expect(prompt).not.toHaveBeenCalled()
    expect(spawnSubagent).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    expect(sessions.lookupOwned("session-1", "chat-1", "pi-native-parent")).toBe(recoveredHandle)
    expect(sessions.lookupOwned("session-1", "chat-1", "/sessions/reopened.jsonl")).toBe(recoveredHandle)
    await expect(Effect.runPromise(retainedPiFleetHandlers(sessions).subagentTranscript(
      { ...owner, runtimeId: "claude" },
      "session-1",
      "chat-1",
      "pi-native-parent",
      "child-1"
    ))).resolves.toHaveLength(1)
  })

  it("starts a fresh turn host while a recovered host keeps proven-live work", async () => {
    const recoveredHandle = handle(() => true)
    const currentHandle = {
      ...handle(() => false),
      id: "/sessions/current.jsonl",
      parentRuntimeSessionId: "pi-current-parent"
    }
    const recoveryFactory: PiSessionFactory = { create: () => Effect.succeed(recoveredHandle) }
    const currentFactory: PiSessionFactory = {
      create: () => Effect.succeed(currentHandle),
      lockedCapabilityFingerprint: () => Effect.succeed("models:current")
    }
    const sessions = new RetainedPiSessionRegistry(recoveryFactory, 60_000, 60_000)
    await Effect.runPromise(sessions.recoverByChat({
      version: 1,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "claude",
      targetId: "device:recovery",
      cwd: "/workspace/recovery",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      updatedAt: Date.now()
    }, spec, context(), recoveryFactory))

    const current = await Effect.runPromise(sessions.acquireByChat(
      spec,
      context(),
      currentFactory,
      "claude"
    ))

    expect(current.handle).toBe(currentHandle)
    expect(sessions.lookupOwned("session-1", "chat-1", "pi-native-parent")).toBe(recoveredHandle)
    expect(sessions.lookupByChat("session-1", "chat-1")).toBe(currentHandle)
    expect(recoveredHandle.dispose).not.toHaveBeenCalled()
    await sessions.release(current)
  })

  it("lazily reopens after idle disposal, dedupes concurrent opens, and preserves target identity", async () => {
    const disposals: Array<ReturnType<typeof vi.fn>> = []
    const createdSpecs: AgentRunSpec[] = []
    const factory: PiSessionFactory = {
      create: (createdSpec) => {
        createdSpecs.push(createdSpec)
        const dispose = vi.fn()
        disposals.push(dispose)
        return Effect.succeed(handle(() => false, dispose))
      }
    }
    const owners = ownerStore()
    const sessions = new RetainedPiSessionRegistry(factory, 5, 15, owners)
    const persisted = {
      version: 1 as const,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex" as const,
      targetId: "device:remote",
      cwd: "/workspace/non-default",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      updatedAt: Date.now()
    }
    sessions.registerRecovery(persisted, {
      ...spec,
      cwd: persisted.cwd,
      targetCapabilities: { ...spec.targetCapabilities, targetId: persisted.targetId }
    }, context(), factory)
    const fleet = retainedPiFleetHandlers(sessions)

    const [first, duplicate] = await Promise.all([
      Effect.runPromise(fleet.subagentFleetSnapshot(
        owner, "session-1", "chat-1", "pi-native-parent"
      )),
      Effect.runPromise(fleet.subagentFleetSnapshot(
        owner, "session-1", "chat-1", "pi-native-parent"
      ))
    ])
    expect(first.totalActive).toBe(0)
    expect(duplicate.totalActive).toBe(0)
    expect(createdSpecs).toHaveLength(1)
    expect(createdSpecs[0]).toMatchObject({
      cwd: "/workspace/non-default",
      continuation: { id: "/sessions/native-sidecar.jsonl" },
      targetCapabilities: { targetId: "device:remote" }
    })
    await vi.waitFor(() => expect(disposals[0]).toHaveBeenCalledOnce())

    await expect(Effect.runPromise(fleet.subagentFleetSnapshot(
      owner, "session-1", "chat-1", "pi-native-parent"
    ))).resolves.toMatchObject({ totalActive: 0 })
    expect(createdSpecs).toHaveLength(2)
    await expect(Effect.runPromise(fleet.subagentTranscript(
      owner, "session-1", "chat-1", "pi-native-parent", "child-1"
    ))).resolves.toHaveLength(1)
    await vi.waitFor(() => expect(disposals[1]).toHaveBeenCalledOnce())

    await expect(Effect.runPromise(fleet.controlSubagent(
      owner, "session-1", "chat-1", control("stop")
    ))).resolves.toMatchObject({ status: "accepted" })
    expect(createdSpecs).toHaveLength(3)
    expect(owners.removeExact).not.toHaveBeenCalled()
  })

  it("expires idle recovery descriptors at runtime without opening them", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const persisted = {
        version: 1 as const,
        sessionId: "session-1",
        chatId: "chat-1",
        runtimeId: "codex" as const,
        targetId: "desktop",
        cwd: "/workspace",
        continuationAlias: "/sessions/native-sidecar.jsonl",
        parentRuntimeSessionId: "pi-native-parent",
        updatedAt: Date.now()
      }
      const owners = ownerStore()
      const factory: PiSessionFactory = { create: vi.fn(() => Effect.succeed(handle(() => false))) }
      const sessions = new RetainedPiSessionRegistry(factory, 5, 15, owners, 100)
      sessions.registerRecovery(persisted, spec, context(), factory)

      await vi.advanceTimersByTimeAsync(101)

      expect(owners.removeExact).toHaveBeenCalledOnce()
      expect(owners.removeExact).toHaveBeenCalledWith(persisted)
      await expect(Effect.runPromise(retainedPiFleetHandlers(sessions).subagentFleetSnapshot(
        owner,
        "session-1",
        "chat-1",
        "pi-native-parent"
      ))).rejects.toMatchObject({ message: "pi session is not active: pi-native-parent" })
      expect(factory.create).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cannot remove a newer owner when an older recovery fails late", async () => {
    const stale = {
      version: 1 as const,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex" as const,
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/sessions/stale.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      updatedAt: Date.now()
    }
    const current = {
      ...stale,
      continuationAlias: "/sessions/current.jsonl",
      updatedAt: stale.updatedAt + 1
    }
    let stored: NativeSidecarOwner | undefined = stale
    const owners = {
      put: vi.fn(async (value: Omit<NativeSidecarOwner, "version" | "updatedAt">) => {
        stored = { version: 1, ...value, updatedAt: 3_000 }
        return stored
      }),
      removeExact: vi.fn(async (value: NativeSidecarOwner) => {
        if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(value)) stored = undefined
      })
    }
    let rejectRecovery!: (cause: unknown) => void
    const pending = new Promise<PiSessionHandle>((_resolve, reject) => { rejectRecovery = reject })
    const staleFactory: PiSessionFactory = {
      create: () => Effect.tryPromise({
        try: () => pending,
        catch: (cause) => new AgentRuntimeError({
          reason: "runtime",
          message: "missing continuation",
          cause
        })
      })
    }
    const currentFactory: PiSessionFactory = { create: () => Effect.succeed(handle(() => false)) }
    const sessions = new RetainedPiSessionRegistry(staleFactory, 60_000, 60_000, owners)
    sessions.registerRecovery(stale, spec, context(), staleFactory)
    const opening = Effect.runPromise(retainedPiFleetHandlers(sessions).subagentFleetSnapshot(
      owner,
      "session-1",
      "chat-1",
      "pi-native-parent"
    ))
    await Promise.resolve()
    sessions.registerRecovery(current, spec, context(), currentFactory)
    stored = current
    rejectRecovery({ code: "ENOENT" })

    await expect(opening).rejects.toMatchObject({ message: "pi session operation failed" })
    expect(owners.removeExact).toHaveBeenCalledWith(stale)
    expect(stored).toEqual(current)
    await expect(Effect.runPromise(retainedPiFleetHandlers(sessions).subagentFleetSnapshot(
      owner,
      "session-1",
      "chat-1",
      "pi-native-parent"
    ))).resolves.toMatchObject({ totalActive: 0 })
  })

  it("removes definitive missing recovery but keeps transient failures retryable", async () => {
    const persisted = {
      version: 1 as const,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex" as const,
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/sessions/native-sidecar.jsonl",
      parentRuntimeSessionId: "pi-native-parent",
      updatedAt: Date.now()
    }
    const owners = ownerStore()
    const missingFactory: PiSessionFactory = {
      create: vi.fn(() => Effect.fail(new AgentRuntimeError({
        reason: "runtime",
        message: "missing continuation",
        cause: { code: "ENOENT" }
      })))
    }
    const missing = new RetainedPiSessionRegistry(missingFactory, 5, 15, owners)
    missing.registerRecovery(persisted, spec, context(), missingFactory)
    const missingFleet = retainedPiFleetHandlers(missing)
    await expect(Effect.runPromise(missingFleet.subagentFleetSnapshot(
      owner, "session-1", "chat-1", "pi-native-parent"
    ))).rejects.toMatchObject({ message: "pi session operation failed" })
    expect(owners.removeExact).toHaveBeenCalledWith(persisted)
    await expect(Effect.runPromise(missingFleet.subagentFleetSnapshot(
      owner, "session-1", "chat-1", "pi-native-parent"
    ))).rejects.toMatchObject({ message: "pi session is not active: pi-native-parent" })
    expect(missingFactory.create).toHaveBeenCalledOnce()

    const transientFactory: PiSessionFactory = {
      create: vi.fn(() => Effect.fail(new AgentRuntimeError({
        reason: "runtime",
        message: "provider unavailable"
      })))
    }
    const transient = new RetainedPiSessionRegistry(transientFactory, 5, 15, owners)
    transient.registerRecovery(persisted, spec, context(), transientFactory)
    const transientFleet = retainedPiFleetHandlers(transient)
    const attempt = () => Effect.runPromise(transientFleet.subagentFleetSnapshot(
      owner, "session-1", "chat-1", "pi-native-parent"
    ))
    await expect(attempt()).rejects.toMatchObject({ message: "pi session operation failed" })
    await expect(attempt()).rejects.toMatchObject({ message: "pi session operation failed" })
    expect(transientFactory.create).toHaveBeenCalledTimes(2)
  })

  it("retains an idle native host for bounded follow-up and fingerprints fallback model changes", async () => {
    const dispose = vi.fn()
    const retainedHandle = handle(() => false, dispose)
    const factory: PiSessionFactory = { create: vi.fn(() => Effect.succeed(retainedHandle)) }
    const sessions = new RetainedPiSessionRegistry(factory, 5, 40)
    const first = await Effect.runPromise(sessions.acquireByChat(spec, context(), factory))
    await sessions.release(first)
    await expect(Effect.runPromise(retainedPiFleetHandlers(sessions).controlSubagent(
      owner,
      "session-1",
      "chat-1",
      control("follow-up")
    ))).resolves.toMatchObject({ status: "accepted" })
    const followUp = await Effect.runPromise(sessions.acquireByChat(spec, context(), factory))
    expect(followUp.handle).toBe(retainedHandle)
    expect(factory.create).toHaveBeenCalledOnce()
    await sessions.release(followUp)
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())

    const firstFingerprint = nativeSidecarCapabilityFingerprint("base", {
      ...spec,
      runtimeId: "codex",
      modelId: ProviderModelId.make("openai/first")
    }, {})
    const secondFingerprint = nativeSidecarCapabilityFingerprint("base", {
      ...spec,
      runtimeId: "codex",
      modelId: ProviderModelId.make("openai/second")
    }, {})
    expect(firstFingerprint).not.toBe(secondFingerprint)
  })
})
