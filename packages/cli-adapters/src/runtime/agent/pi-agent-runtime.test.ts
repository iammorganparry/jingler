import { CURRENT_RUNTIME_CONTRACTS, ProviderConnectionId, ProviderModelId, type PiRunSpec } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import { makePiAgentRuntime, type PiSessionHandle } from "./pi-agent-runtime.js"

const spec: PiRunSpec = {
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
  role: "conversation",
  mode: "ask",
  cwd: "/workspace",
  prompt: "hello",
  priorMessages: [],
  piSessionId: null,
  seed: null,
  targetCapabilities: { versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [], targetId: "desktop" }
}

const context: AgentRuntimeContext = {
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([]),
  saveDraftPlan: () => Effect.void,
  proposePlan: () => Effect.succeed({ _tag: "Reject" })
}

describe("PiAgentRuntime", () => {
  it("streams one terminal event and disposes the pi session", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const dispose = vi.fn()
    const handle: PiSessionHandle = {
      id: "pi-session-1",
      modelId: "anthropic/claude-sonnet",
      subscribe: (next) => { listener = next; return vi.fn() },
      prompt: async () => {
        listener?.({ type: "message_update", message: {} as never, assistantMessageEvent: { type: "text_delta", delta: "hello" } as never })
        listener?.({ type: "agent_settled" })
      },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose,
      usage: () => ({ costUsd: 0, tokens: 3 })
    }
    const runtime = await Effect.runPromise(makePiAgentRuntime({ create: () => Effect.succeed(handle) }))
    const events = await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
    expect([...events].map((event) => event._tag)).toEqual(["Started", "Assistant", "Done"])
    expect([...events].filter((event) => event._tag === "Done" || event._tag === "Failed")).toHaveLength(1)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("surfaces prompt rejection as a single failed terminal", async () => {
    const handle: PiSessionHandle = {
      id: "pi-session-2",
      modelId: "anthropic/claude-sonnet",
      subscribe: () => vi.fn(),
      prompt: async () => { throw new Error("offline") },
      steer: async () => undefined,
      interrupt: async () => undefined,
      dispose: vi.fn(),
      usage: () => ({ costUsd: 0, tokens: 0 })
    }
    const runtime = await Effect.runPromise(makePiAgentRuntime({ create: () => Effect.succeed(handle) }))
    const events = [...await Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))]
    expect(events.at(-1)).toEqual({ _tag: "Failed", message: "pi prompt failed" })
  })
})

describe("PiAgentRuntime reconciliation", () => {
  it("emits final file reconciliation before the terminal event", async () => {
    let listener: ((event: AgentSessionEvent) => void) | null = null
    const handle: PiSessionHandle = {
      id: "pi-session-3",
      modelId: "anthropic/claude-sonnet",
      subscribe: (next) => { listener = next; return vi.fn() },
      prompt: async () => { listener?.({ type: "agent_settled" }) },
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
    const events = [
      ...(await Effect.runPromise(Stream.runCollect(runtime.run(spec, context))))
    ]
    expect(events.map((event) => event._tag)).toEqual([
      "Started",
      "ToolStart",
      "ToolEnd",
      "Done"
    ])
  })
})
