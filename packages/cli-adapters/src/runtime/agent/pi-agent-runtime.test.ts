import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  piEndpointId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import {
  AgentRuntimeError,
  inactiveRuntimeActivity,
  type AgentRuntimeContext
} from "./agent-runtime.js"
import {
  makePiAgentRuntime,
  type PiSessionHandle
} from "./pi-agent-runtime.js"

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("connection-1")
const endpointId = piEndpointId("desktop", connectionId)
const piContinuation = (id: string) => ({ runtimeId: "pi" as const, endpointId, id })
const owner = { runtimeId: "pi" as const, endpointId, targetId: "desktop" }

const spec: AgentRunSpec = {
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId,
  connectionId,
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
  role: "conversation",
  mode: "ask",
  cwd: "/workspace",
  prompt: "hello",
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

const fleetSeams: Pick<
  PiSessionHandle,
  "parentRuntimeSessionId" | "subscribeFleet" | "controlSubagent" | "subagentFleetSnapshot" | "subagentTranscript"
> = {
  parentRuntimeSessionId: "pi-session-internal",
  subscribeFleet: () => () => undefined,
  subagentFleetSnapshot: async () => ({
    version: 2,
    parentRuntimeSessionId: "pi-session",
    registryRevision: 0,
    generatedAt: 1,
    totalActive: 0,
    omitted: 0,
    activeCapacity: { used: 0, limit: 0 },
    nodes: []
  }),
  subagentTranscript: async () => [],
  controlSubagent: async (request) => ({
    version: 2,
    requestId: request.requestId,
    runId: request.runId,
    action: request.action,
    acknowledged: true,
    status: "accepted",
    deliveryStatus: "delivered",
    sequence: 1,
    nativeRequestId: "native-1",
    message: "acknowledged",
    acknowledgedAt: 1
  })
}

const context: AgentRuntimeContext = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([]),
}

/** A handle that settles each prompt immediately, retained while `fleet.childActive`. */
const settlingHandle = (fleet: { childActive: boolean }): PiSessionHandle => ({
  ...fleetSeams,
  id: "/sessions/parent.jsonl",
  parentRuntimeSessionId: "pi-parent-internal",
  modelId: "anthropic/claude-sonnet",
  contextWindow: 200_000,
  subscribe: (next) => {
    queueMicrotask(() => next({ type: "agent_settled" }))
    return vi.fn()
  },
  prompt: async () => undefined,
  steer: async () => undefined,
  interrupt: async () => undefined,
  dispose: vi.fn(),
  subagentFleetSnapshot: async () => ({
    version: 2,
    parentRuntimeSessionId: "pi-parent-internal",
    registryRevision: 0,
    generatedAt: 1,
    totalActive: fleet.childActive ? 1 : 0,
    omitted: 0,
    activeCapacity: { used: fleet.childActive ? 1 : 0, limit: 4 },
    nodes: []
  }),
  usage: () => ({ costUsd: 0, tokens: 1 })
})

describe("PiAgentRuntime", () => {
  it("passes current-turn images to the Pi session prompt", async () => {
    const prompt = vi.fn(async () => undefined)
    const handle = { ...settlingHandle({ childActive: false }), prompt }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const image = {
      id: "image-1",
      name: "form.png",
      mediaType: "image/png",
      data: "aGVsbG8="
    }

    await Effect.runPromise(Stream.runCollect(runtime.run({ ...spec, images: [image] }, context)))

    expect(prompt).toHaveBeenCalledWith("hello", [image])
  })

  it("normalizes session construction failure as one terminal event", async () => {
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({
        create: () =>
          Effect.fail(
            new AgentRuntimeError({
              reason: "certification",
              message: "model certification is stale"
            })
          )
      })
    )
    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]
    expect(events).toEqual([{ _tag: "Failed", message: "model certification is stale" }])
  })

  it("streams one terminal event and disposes the pi session", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    let disposed = false
    const dispose = vi.fn(async () => {
      await Effect.runPromise(Effect.sleep("10 millis"))
      disposed = true
    })
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-1",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: {
            type: "text_delta",
            delta: "hello"
          } as never
        })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose,
      usage: () => ({ costUsd: 0, tokens: 3 })
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
    expect([...events].map((event) => event._tag)).toEqual(["Started", "Assistant", "Done"])
    expect(
      [...events].filter((event) => event._tag === "Done" || event._tag === "Failed")
    ).toHaveLength(1)
    expect(dispose).toHaveBeenCalledOnce()
    expect(disposed).toBe(true)
  })

  it("delivers the terminal event before closing a slow consumer", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-slow-consumer",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: {
            type: "text_delta",
            delta: "hello"
          } as never
        })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 3 })
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = await Effect.runPromise(
      runtime.run(spec, context).pipe(
        Stream.mapEffect((event) => Effect.sleep("10 millis").pipe(Effect.as(event))),
        Stream.runCollect
      )
    )
    expect([...events].map((event) => event._tag)).toEqual(["Started", "Assistant", "Done"])
  })

  it("keeps a provider error provisional when pi retries successfully", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-retry",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: {
            type: "error",
            reason: "error",
            error: { errorMessage: "rate limited" }
          } as never
        })
        listener?.({
          type: "auto_retry_end",
          attempt: 1,
          success: true
        })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 3 })
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]

    expect(events.map((event) => event._tag)).toEqual([
      "Started",
      "RetryFinished",
      "Done"
    ])
  })

  it("reconciles before settling an unrecovered provider failure", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const reconcile = vi.fn(async () => null)
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-provider-failure",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider unavailable"
          } as never
        })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 0 }),
      reconcile
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]

    expect(reconcile).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({
      _tag: "Failed",
      message: "provider unavailable"
    })
  })

  it("retains a detached Fleet across parent settlement and persisted continuation", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    let childActive = true
    const dispose = vi.fn()
    const prompt = vi.fn(async () => {
      listener?.({ type: "agent_settled" })
    })
    const controlSubagent = vi.fn(fleetSeams.controlSubagent)
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "/sessions/parent.jsonl",
      parentRuntimeSessionId: "pi-parent-internal",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt,
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose,
      subagentFleetSnapshot: async () => ({
        version: 2,
        parentRuntimeSessionId: "pi-parent-internal",
        registryRevision: 0,
        generatedAt: Date.now(),
        totalActive: childActive ? 1 : 0,
        omitted: 0,
        activeCapacity: { used: childActive ? 1 : 0, limit: 4 },
        nodes: []
      }),
      subagentTranscript: async () => [{
        id: "message-1",
        role: "assistant",
        parts: [{ _tag: "Text", text: "still working" }],
        streaming: false,
        createdAt: "2026-08-10T00:00:00.000Z"
      }],
      controlSubagent,
      usage: () => ({ costUsd: 0, tokens: 1 })
    }
    const create = vi.fn(() => Effect.succeed(handle))
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create }, { retainedSessionPollMs: 10 })
    )

    await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
    expect(dispose).not.toHaveBeenCalled()
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot(owner, "session-1", "chat-1", "/sessions/parent.jsonl")))
      .resolves.toMatchObject({ totalActive: 1 })
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot(owner, "session-1", "chat-1", "pi-parent-internal")))
      .resolves.toMatchObject({ totalActive: 1 })
    await expect(Effect.runPromise(
      runtime.subagentTranscript(owner,
        "session-1",
        "chat-1",
        "pi-parent-internal",
        "child-1"
      )
    )).resolves.toHaveLength(1)
    const foreignChat = await Effect.runPromise(Effect.either(
      runtime.subagentTranscript(owner,
        "session-1",
        "another-chat",
        "pi-parent-internal",
        "child-1"
      )
    ))
    expect(foreignChat._tag).toBe("Left")
    await Effect.runPromise(runtime.controlSubagent(owner, "session-1", "chat-1", {
      version: 2,
      requestId: "control-1",
      parentRuntimeSessionId: "pi-parent-internal",
      runId: "child-1",
      action: "stop",
      message: null,
      replyTo: null
    }))
    expect(controlSubagent).toHaveBeenCalledOnce()

    await Effect.runPromise(Stream.runCollect(runtime.run({
      ...spec,
      runId: "run-2",
      prompt: "continue",
      continuation: piContinuation("/sessions/parent.jsonl")
    }, context)))
    expect(create).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(dispose).not.toHaveBeenCalled()

    childActive = false
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    const missing = await Effect.runPromise(
      Effect.either(runtime.subagentFleetSnapshot(owner, "session-1", "chat-1", "pi-parent-internal"))
    )
    expect(missing._tag).toBe("Left")
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot(owner, "session-1", "chat-1", "/sessions/parent.jsonl")))
      .rejects.toMatchObject({ message: "pi session is not active: /sessions/parent.jsonl" })
    await expect(Effect.runPromise(runtime.subagentTranscript(owner,
      "session-1",
      "chat-1",
      "pi-parent-internal",
      "child-1"
    ))).resolves.toHaveLength(1)
  })

  it("routes a retained session's interactive tools to the CURRENT turn's context", async () => {
    // The factory builds the session's custom tools once, closing over the
    // context it was handed at create. A retained continuation turn must still
    // reach the NEW turn's askQuestion — the creating turn's mailbox has ended.
    let listener: ((event: AgentSessionEvent) => void) | null = null
    let toolContext: AgentRuntimeContext | null = null
    const observedMcp: Array<AgentRuntimeContext["mcp"]> = []
    let childActive = true
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "/sessions/parent.jsonl",
      parentRuntimeSessionId: "pi-parent-internal",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      // Each prompt simulates the agent invoking jingler_ask_question through
      // the tools the factory captured at CREATE time.
      prompt: async () => {
        observedMcp.push(toolContext!.mcp)
        await Effect.runPromise(
          toolContext!.askQuestion({ id: "q-1", questions: [] })
        )
        await Effect.runPromise(toolContext!.publishExplanation?.({
          title: "Current turn",
          summary: "The callback follows the retained session.",
          sections: []
        }) ?? Effect.void)
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      subagentFleetSnapshot: async () => ({
        version: 2,
        parentRuntimeSessionId: "pi-parent-internal",
        registryRevision: 0,
        generatedAt: 1,
        totalActive: childActive ? 1 : 0,
        omitted: 0,
        activeCapacity: { used: childActive ? 1 : 0, limit: 4 },
        nodes: []
      }),
      usage: () => ({ costUsd: 0, tokens: 1 })
    }
    const create = vi.fn((_spec: AgentRunSpec, created: AgentRuntimeContext) => {
      toolContext = created
      return Effect.succeed(handle)
    })
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create }, { retainedSessionPollMs: 10 })
    )

    const firstAsk = vi.fn(() => Effect.succeed([]))
    const secondAsk = vi.fn(() => Effect.succeed([]))
    const firstPublish = vi.fn(() => Effect.void)
    const secondPublish = vi.fn(() => Effect.void)
    const firstMcp = { browser: { name: "jingler-browser", url: "http://127.0.0.1:1111/mcp", headers: {} } }
    const secondMcp = { browser: { name: "jingler-browser", url: "http://127.0.0.1:2222/mcp", headers: {} } }
    await Effect.runPromise(
      Stream.runCollect(
        runtime.run(spec, {
          ...context,
          askQuestion: firstAsk,
          publishExplanation: firstPublish,
          mcp: firstMcp
        })
      )
    )
    expect(firstAsk).toHaveBeenCalledOnce()
    expect(observedMcp[0]).toBe(firstMcp)
    expect(toolContext!.mcp?.browser).toBeNull()

    await Effect.runPromise(
      Stream.runCollect(
        runtime.run(
          { ...spec, runId: "run-2", prompt: "continue", continuation: piContinuation("/sessions/parent.jsonl") },
          {
            ...context,
            askQuestion: secondAsk,
            publishExplanation: secondPublish,
            mcp: secondMcp
          }
        )
      )
    )
    expect(create).toHaveBeenCalledOnce()
    expect(firstAsk).toHaveBeenCalledOnce()
    expect(secondAsk).toHaveBeenCalledOnce()
    expect(firstPublish).toHaveBeenCalledOnce()
    expect(secondPublish).toHaveBeenCalledOnce()
    // Per-run attachments (the browser lease) must read through to the
    // CURRENT turn — a snapshot of turn 1's lease is a dead endpoint.
    expect(observedMcp[1]).toBe(secondMcp)
    expect(toolContext!.mcp?.browser).toBeNull()
    childActive = false
  })

  it.each([
    ["model", {
      modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-opus")
    }],
    ["connection", {
      connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-2")
    }]
  ])("rebuilds a retained session when its %s changes", async (_name, changed) => {
    const fleet = { childActive: true }
    const handles: PiSessionHandle[] = []
    const create = vi.fn((createdSpec: AgentRunSpec) => {
      const handle = {
        ...settlingHandle(fleet),
        modelId: String(createdSpec.modelId)
      }
      handles.push(handle)
      return Effect.succeed(handle)
    })
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create }, { retainedSessionPollMs: 10 })
    )

    await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
    await Effect.runPromise(Stream.runCollect(runtime.run(
      {
        ...spec,
        ...changed,
        runId: "run-switched",
        continuation: piContinuation("/sessions/parent.jsonl")
      },
      context
    )))

    expect(create).toHaveBeenCalledTimes(2)
    expect(handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      ...changed,
      continuation: piContinuation("/sessions/parent.jsonl")
    })
    fleet.childActive = false
  })

  it("rebuilds a retained session when a dynamically resolved catalog changes", async () => {
    const fleet = { childActive: true }
    let catalog = "managed-mcp:alpha"
    const handles: PiSessionHandle[] = []
    const create = vi.fn(() => {
      const handle = settlingHandle(fleet)
      handles.push(handle)
      return Effect.succeed(handle)
    })
    const lockedCapabilityFingerprint = vi.fn(() => Effect.succeed(catalog))
    const runtime = await Effect.runPromise(
      makePiAgentRuntime(
        { create, lockedCapabilityFingerprint },
        { retainedSessionPollMs: 10 }
      )
    )

    await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
    await Effect.runPromise(Stream.runCollect(runtime.run(
      { ...spec, runId: "run-2", prompt: "unchanged", continuation: piContinuation("/sessions/parent.jsonl") },
      context
    )))
    expect(create).toHaveBeenCalledOnce()

    catalog = "managed-mcp:replacement"
    await Effect.runPromise(Stream.runCollect(runtime.run(
      { ...spec, runId: "run-3", prompt: "catalog changed", continuation: piContinuation("/sessions/parent.jsonl") },
      context
    )))

    expect(lockedCapabilityFingerprint).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(2)
    expect(handles[0]?.dispose).toHaveBeenCalledOnce()
    fleet.childActive = false
  })

  it("rebuilds a retained session when the turn role changes, reusing its session file", async () => {
    // Tools and prompt resources are locked per role at session creation. A
    // plan-role session reused for a plan-execution turn ran the approved plan
    // with the planning toolset — no edit or command tools, implementation
    // permanently blocked. A role change must dispose and recreate; the
    // factory reopens the same pi session file so model context carries over.
    const fleet = { childActive: true }
    const handles: PiSessionHandle[] = []
    const create = vi.fn((_spec: AgentRunSpec, _context: AgentRuntimeContext) => {
      const handle = settlingHandle(fleet)
      handles.push(handle)
      return Effect.succeed(handle)
    })
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create }, { retainedSessionPollMs: 10 })
    )

    await Effect.runPromise(
      Stream.runCollect(runtime.run({ ...spec, role: "plan", mode: "plan" }, context))
    )
    expect(create).toHaveBeenCalledOnce()

    await Effect.runPromise(
      Stream.runCollect(
        runtime.run(
          {
            ...spec,
            runId: "run-2",
            prompt: "execute the plan",
            role: "plan-execution",
            mode: "auto",
            continuation: piContinuation("/sessions/parent.jsonl")
          },
          context
        )
      )
    )
    expect(create).toHaveBeenCalledTimes(2)
    // The stale plan-role session was disposed, not leaked.
    expect(handles[0]?.dispose).toHaveBeenCalled()
    // The recreation resumes the SAME session file with the new role: the
    // factory reopens it because continuation is set and seed stays null.
    const recreation = create.mock.calls[1]?.[0]
    expect(recreation?.role).toBe("plan-execution")
    expect(recreation?.continuation?.id).toBe("/sessions/parent.jsonl")
    expect(recreation?.seed).toBeNull()
    fleet.childActive = false
  })

  it("surfaces prompt rejection when final reconciliation also rejects", async () => {
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-2",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: () => vi.fn(),
      prompt: async () => {
        throw new Error("offline")
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 0 }),
      reconcile: async () => {
        throw new Error("snapshot unavailable")
      }
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]
    expect(events.at(-1)).toEqual({
      _tag: "Failed",
      message: "pi prompt failed: offline"
    })
  })
})

describe("PiAgentRuntime reconciliation", () => {
  it("emits final file reconciliation before the terminal event", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-3",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 0 }),
      reconcile: async () => ({
        id: "set-1",
        callId: null,
        changes: [
          {
            status: "A",
            path: "created.ts",
            oldPath: null,
            added: 1,
            removed: 0,
            binary: false,
            noNewlineAtEnd: false,
            beforeBytes: null,
            afterBytes: 1,
            preview: "+x",
            patchArtifactId: "artifact-1"
          }
        ],
        totals: { added: 1, removed: 0 },
        authoritative: true,
        reconciledAt: "2026-08-10T00:00:00.000Z"
      })
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )
    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]
    expect(events.map((event) => event._tag)).toEqual(["Started", "ToolStart", "ToolEnd", "Done"])
  })
})
