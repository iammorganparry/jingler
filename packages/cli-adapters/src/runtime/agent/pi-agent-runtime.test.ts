import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  type PiRunSpec
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
  MEMORY_REFLECTION_TIMEOUT_MS,
  type PiSessionHandle
} from "./pi-agent-runtime.js"

const spec: PiRunSpec = {
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
  role: "conversation",
  mode: "ask",
  cwd: "/workspace",
  prompt: "hello",
  priorMessages: [],
  piSessionId: null,
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
  "parentPiSessionId" | "subscribeFleet" | "controlSubagent" | "subagentFleetSnapshot" | "subagentTranscript"
> = {
  parentPiSessionId: "pi-session-internal",
  subscribeFleet: () => () => undefined,
  subagentFleetSnapshot: async () => ({
    version: 2,
    parentPiSessionId: "pi-session",
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
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed({ _tag: "Reject" })
}

describe("PiAgentRuntime", () => {
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

  it("runs one hidden memory reflection before emitting Done", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const prompts: string[] = []
    const reflectionPrompt = vi.fn(() => "<memory-reflection>Reflect silently.</memory-reflection>")
    const setMemoryReflectionActive = vi.fn()
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-memory-reflection",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async (prompt) => {
        prompts.push(prompt)
        listener?.({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: {
            type: "text_delta",
            delta: prompts.length === 1 ? "visible answer" : "hidden reflection prose"
          } as never
        })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 5 }),
      memoryReflectionPrompt: reflectionPrompt,
      setMemoryReflectionActive
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )

    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]

    expect(prompts).toEqual([
      "hello",
      "<memory-reflection>Reflect silently.</memory-reflection>"
    ])
    expect(reflectionPrompt).toHaveBeenCalledOnce()
    expect(setMemoryReflectionActive.mock.calls).toEqual([[true], [false]])
    expect(events.map((event) => event._tag)).toEqual(["Started", "Assistant", "Done"])
    expect(events.flatMap((event) => event._tag === "Assistant" ? [event.text] : []))
      .toEqual(["visible answer"])
  })

  it("ignores provider failures from the optional hidden reflection", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    let promptCount = 0
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-reflection-provider-failure",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        promptCount += 1
        if (promptCount === 2) {
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "reflection provider unavailable"
            } as never
          })
        }
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 3 }),
      memoryReflectionPrompt: () => "<memory-reflection>Reflect.</memory-reflection>"
    }
    const runtime = await Effect.runPromise(
      makePiAgentRuntime({ create: () => Effect.succeed(handle) })
    )

    const events = [...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))]

    expect(events.at(-1)).toMatchObject({ _tag: "Done" })
    expect(events.some((event) => event._tag === "Failed")).toBe(false)
  })

  it("interrupts and settles a hidden reflection at its hard deadline", async () => {
    vi.useFakeTimers()
    try {
      let listener: ((event: AgentSessionEvent) => void) | null = null
      let promptCount = 0
      const interrupt = vi.fn(async () => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "reflection interrupted at deadline"
          } as never
        })
        listener?.({ type: "agent_settled" })
      })
      const handle: PiSessionHandle = {
        ...fleetSeams,
        id: "pi-session-reflection-timeout",
        modelId: "anthropic/claude-sonnet",
        contextWindow: 200_000,
        subscribe: (next) => {
          listener = next
          return vi.fn()
        },
        prompt: async () => {
          promptCount += 1
          if (promptCount === 1) listener?.({ type: "agent_settled" })
          else await new Promise<void>(() => undefined)
        },
        steer: async () => undefined,
        interrupt,
        dispose: vi.fn(),
        usage: () => ({ costUsd: 0, tokens: 3 }),
        memoryReflectionPrompt: () => "<memory-reflection>Reflect.</memory-reflection>"
      }
      const runtime = await Effect.runPromise(
        makePiAgentRuntime({ create: () => Effect.succeed(handle) })
      )
      const eventsPromise = Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
      await vi.advanceTimersByTimeAsync(MEMORY_REFLECTION_TIMEOUT_MS)

      const events = [...(await eventsPromise)]
      expect(interrupt).toHaveBeenCalledOnce()
      expect(events.at(-1)).toMatchObject({ _tag: "Done" })
    } finally {
      vi.useRealTimers()
    }
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

  it("streams schema-validated plan tool arguments as volatile plan drafts", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const plan = {
      title: "Refactor auth flow",
      sections: [],
      stages: [],
      annotations: []
    }
    const partial = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "plan-call",
          name: "jingler_submit_plan",
          arguments: {}
        }
      ]
    } as never
    const handle: PiSessionHandle = {
      ...fleetSeams,
      id: "pi-session-plan-draft",
      modelId: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      prompt: async () => {
        listener?.({ type: "message_start", message: partial })
        listener?.({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"plan":{"title":"Refactor auth flow"',
            partial
          }
        } as never)
        listener?.({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: {
              type: "toolCall",
              id: "plan-call",
              name: "jingler_submit_plan",
              arguments: { plan }
            },
            partial
          }
        } as never)
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
    expect(
      events.flatMap((event) => (event._tag === "PlanDraft" ? [event.draft.phase] : []))
    ).toEqual(["composing", "complete"])
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
      parentPiSessionId: "pi-parent-internal",
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
        parentPiSessionId: "pi-parent-internal",
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
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot("session-1", "chat-1", "/sessions/parent.jsonl")))
      .resolves.toMatchObject({ totalActive: 1 })
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot("session-1", "chat-1", "pi-parent-internal")))
      .resolves.toMatchObject({ totalActive: 1 })
    await expect(Effect.runPromise(
      runtime.subagentTranscript(
        "session-1",
        "chat-1",
        "pi-parent-internal",
        "child-1"
      )
    )).resolves.toHaveLength(1)
    const foreignChat = await Effect.runPromise(Effect.either(
      runtime.subagentTranscript(
        "session-1",
        "another-chat",
        "pi-parent-internal",
        "child-1"
      )
    ))
    expect(foreignChat._tag).toBe("Left")
    await Effect.runPromise(runtime.controlSubagent("session-1", "chat-1", {
      version: 2,
      requestId: "control-1",
      parentPiSessionId: "pi-parent-internal",
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
      piSessionId: "/sessions/parent.jsonl"
    }, context)))
    expect(create).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(dispose).not.toHaveBeenCalled()

    childActive = false
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    const missing = await Effect.runPromise(
      Effect.either(runtime.subagentFleetSnapshot("session-1", "chat-1", "pi-parent-internal"))
    )
    expect(missing._tag).toBe("Left")
    await expect(Effect.runPromise(runtime.subagentFleetSnapshot("session-1", "chat-1", "/sessions/parent.jsonl")))
      .rejects.toMatchObject({ message: "pi session is not active: /sessions/parent.jsonl" })
    await expect(Effect.runPromise(runtime.subagentTranscript(
      "session-1",
      "chat-1",
      "pi-parent-internal",
      "child-1"
    ))).resolves.toHaveLength(1)
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
      message: "pi prompt failed"
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
