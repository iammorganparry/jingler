import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  type AgentRunSpec,
  type RuntimeContinuation
} from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  inactiveRuntimeActivity,
  makeAgentRuntimeRegistry,
  makeAgentRuntimeRouter,
  type AgentRuntimeContext,
  type AgentRuntimeShape
} from "./agent-runtime.js"

const endpointId = AgentEndpointId.make("desktop:pi:connection-1")
const continuation = (over: Partial<RuntimeContinuation> = {}): RuntimeContinuation => ({
  runtimeId: "pi",
  endpointId,
  id: "pi-session",
  ...over
})
const spec = (over: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId,
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-test"),
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
  },
  ...over
})
const context: AgentRuntimeContext = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("deny"),
  askQuestion: () => Effect.succeed([])
}

const runtime = (): AgentRuntimeShape => ({
  run: vi.fn(() => Stream.empty),
  steer: vi.fn(() => Effect.void),
  interrupt: vi.fn(() => Effect.void),
  controlSubagent: vi.fn(() => Effect.die("unused")),
  decidePlanReview: vi.fn(() => Effect.die("unused")),
  subagentFleetSnapshot: vi.fn(() => Effect.die("unused")),
  subagentTranscript: vi.fn(() => Effect.die("unused"))
})

const routerFor = (adapter: AgentRuntimeShape) => makeAgentRuntimeRouter(
  makeAgentRuntimeRegistry([{
    runtimeId: "pi",
    runtime: adapter,
    ownsEndpoint: (candidate, targetId) =>
      candidate === endpointId && targetId === "desktop"
  }])
)

describe("AgentRuntime router", () => {
  it("dispatches an owned run to its registered runtime", async () => {
    const adapter = runtime()
    await Effect.runPromise(routerFor(adapter).run(spec(), context).pipe(Stream.runDrain))
    expect(adapter.run).toHaveBeenCalledOnce()
  })

  it("dispatches concurrent PI and Claude chats to separate runtimes", async () => {
    const pi = runtime()
    const claude = runtime()
    const claudeEndpoint = AgentEndpointId.make("desktop:claude:default")
    const router = makeAgentRuntimeRouter(makeAgentRuntimeRegistry([
      {
        runtimeId: "pi",
        runtime: pi,
        ownsEndpoint: (candidate, targetId) => candidate === endpointId && targetId === "desktop"
      },
      {
        runtimeId: "claude",
        runtime: claude,
        ownsEndpoint: (candidate, targetId) => candidate === claudeEndpoint && targetId === "desktop"
      }
    ]))

    await Effect.runPromise(Effect.all([
      router.run(spec(), context).pipe(Stream.runDrain),
      router.run(spec({
        runtimeId: "claude",
        endpointId: claudeEndpoint,
        connectionId: undefined,
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/opus")
      }), context).pipe(Stream.runDrain)
    ], { concurrency: "unbounded" }))

    expect(pi.run).toHaveBeenCalledOnce()
    expect(claude.run).toHaveBeenCalledOnce()
  })

  it("rejects a continuation owned by another endpoint", async () => {
    const adapter = runtime()
    const exit = await Effect.runPromiseExit(
      routerFor(adapter).run(spec({
        continuation: continuation({ endpointId: AgentEndpointId.make("desktop:pi:other") })
      }), context).pipe(Stream.runDrain)
    )
    expect(exit._tag).toBe("Failure")
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it("rejects an endpoint on the wrong target before run, steer, or interrupt", async () => {
    const adapter = runtime()
    const router = routerFor(adapter)
    const wrongTargetSpec = spec({
      targetCapabilities: {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [],
        resourceIds: [],
        targetId: "device-1"
      }
    })

    expect((await Effect.runPromiseExit(
      router.run(wrongTargetSpec, context).pipe(Stream.runDrain)
    ))._tag).toBe("Failure")
    expect((await Effect.runPromiseExit(
      router.steer(continuation(), "device-1", "continue")
    ))._tag).toBe("Failure")
    expect((await Effect.runPromiseExit(
      router.interrupt(continuation(), "device-1")
    ))._tag).toBe("Failure")
    expect(adapter.run).not.toHaveBeenCalled()
    expect(adapter.steer).not.toHaveBeenCalled()
    expect(adapter.interrupt).not.toHaveBeenCalled()
  })
})
