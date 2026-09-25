import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  piEndpointId,
  type StreamEvent
} from "@jingler/core"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  type AgentContext,
  AgentTurnDriver,
  type AgentTurnSpec,
  type SteerTurn
} from "../../agent-turn-driver.js"
import { AgentRuntime, type AgentRuntimeShape } from "./agent-runtime.js"
import { AgentTurnDriverLive } from "./agent-turn-driver-live.js"

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("connection-1")

const spec = (): AgentTurnSpec => ({
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId: piEndpointId("desktop", connectionId),
  connectionId,
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-test"),
  role: "conversation",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  },
  cwd: "/tmp/jingler",
  prompt: "Inspect the repository",
  images: [],
  mode: "ask",
  mcp: {
    browser: {
      name: "jingler-browser",
      url: "http://127.0.0.1:43123/mcp",
      headers: { authorization: "Bearer scoped" }
    }
  }
})

const context = (): AgentContext => ({
  emit: vi.fn((_event: StreamEvent) => Effect.void),
  canUseTool: vi.fn(() => Effect.succeed("allow" as const)),
  askQuestion: vi.fn(() => Effect.succeed([])),
  registerBackgroundStop: vi.fn(() => Effect.void),
  registerTurnSteer: vi.fn((_steer: SteerTurn | null) => Effect.void)
})

const withRuntime = <A, E>(
  runtime: AgentRuntimeShape,
  effect: Effect.Effect<A, E, AgentTurnDriver>
) =>
  effect.pipe(
    Effect.provide(
      AgentTurnDriverLive.pipe(Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of(runtime))))
    )
  )

describe("AgentRuntimeAdapter", () => {
  it("routes the legacy orchestration sink through AgentRuntime", async () => {
    const events: ReadonlyArray<StreamEvent> = [
      {
        _tag: "Started",
        sessionId: "pi-session",
        model: "anthropic/claude-test"
      },
      { _tag: "Assistant", text: "done" },
      { _tag: "Done", costUsd: 0, tokens: 2 }
    ]
    const run = vi.fn<AgentRuntimeShape["run"]>((_spec, _context) => Stream.fromIterable(events))
    const image = { id: "image-1", name: "form.png", mediaType: "image/png", data: "aGVsbG8=" }
    const turnSpec = { ...spec(), images: [image] }
    const ctx = context()
    const emit = vi.mocked(ctx.emit)
    const registerTurnSteer = vi.mocked(ctx.registerTurnSteer!)

    await Effect.runPromise(
      withRuntime(
        {
          run,
          steer: () => Effect.void,
          interrupt: () => Effect.void,
          controlSubagent: () => Effect.die("unused"),
      decidePlanReview: () => Effect.die("unused"),
          subagentFleetSnapshot: () => Effect.die("unused"),
          subagentTranscript: () => Effect.die("unused")
        },
        Effect.flatMap(AgentTurnDriver, (adapter) => adapter.run("run-1", turnSpec, ctx))
      )
    )

    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "connection-1",
      modelId: "anthropic/claude-test",
      prompt: "Inspect the repository",
      images: [image]
    })
    expect(run.mock.calls[0]?.[1].mcp?.browser?.name).toBe("jingler-browser")
    expect(run.mock.calls[0]?.[1].publishEvent).toBe(ctx.emit)
    expect(run.mock.calls[0]?.[1].registerBackgroundStop).toBe(ctx.registerBackgroundStop)
    expect(emit.mock.calls.map(([event]) => event._tag)).toEqual(["Started", "Assistant", "Done"])
    expect(registerTurnSteer).toHaveBeenCalled()
  })

  it("steers text through the runtime but reports image-bearing messages unsupported", async () => {
    // `deferred` for images meant "retry at the next boundary" — a retry that
    // could never succeed, so "Send now" on an image message died silently.
    // `unsupported` licenses the renderer to stop and replay as a fresh turn.
    const events: ReadonlyArray<StreamEvent> = [
      { _tag: "Started", sessionId: "pi-session", model: "anthropic/claude-test" },
      { _tag: "Done", costUsd: 0, tokens: 2 }
    ]
    const steer = vi.fn(() => Effect.void)
    const ctx = context()
    let handle: SteerTurn | null = null
    vi.mocked(ctx.registerTurnSteer!).mockImplementation((next) =>
      Effect.sync(() => {
        handle = handle ?? next
      })
    )

    await Effect.runPromise(
      withRuntime(
        {
          run: () => Stream.fromIterable(events),
          steer,
          interrupt: () => Effect.void,
          controlSubagent: () => Effect.die("unused"),
      decidePlanReview: () => Effect.die("unused"),
          subagentFleetSnapshot: () => Effect.die("unused"),
          subagentTranscript: () => Effect.die("unused")
        },
        Effect.flatMap(AgentTurnDriver, (adapter) => adapter.run("run-1", spec(), ctx))
      )
    )

    const image = {
      id: "att-1",
      name: "shot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo="
    }
    await expect(handle!("look at this", [image])).resolves.toBe("unsupported")
    expect(steer).not.toHaveBeenCalled()

    await expect(handle!("plain text", [])).resolves.toBe("accepted")
    expect(steer).toHaveBeenCalledWith(
      { runtimeId: "pi", endpointId: spec().endpointId, id: "pi-session" },
      "desktop",
      "plain text"
    )
  })

  it("interrupts the active pi session when the run fiber is interrupted", async () => {
    const interrupt = vi.fn(() => Effect.void)
    let markStarted!: () => void
    const held = new Promise<void>(() => undefined)
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const runtime: AgentRuntimeShape = {
      run: () =>
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              markStarted()
              return {
                _tag: "Started" as const,
                sessionId: "pi-session",
                model: "anthropic/claude-test"
              }
            })
          ),
          Stream.fromEffect(Effect.promise(() => held)).pipe(Stream.drain)
        ),
      steer: () => Effect.void,
      interrupt,
      controlSubagent: () => Effect.die("unused"),
      decidePlanReview: () => Effect.die("unused"),
      subagentFleetSnapshot: () => Effect.die("unused"),
      subagentTranscript: () => Effect.die("unused")
    }
    const layer = AgentTurnDriverLive.pipe(
      Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of(runtime)))
    )
    const program = Effect.gen(function* () {
      const adapter = yield* AgentTurnDriver
      const fiber = yield* Effect.fork(adapter.run("run-1", spec(), context()))
      yield* Effect.promise(() => started)
      return yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(layer))

    await Effect.runPromise(program)
    expect(interrupt).toHaveBeenCalledWith(
      { runtimeId: "pi", endpointId: spec().endpointId, id: "pi-session" },
      "desktop"
    )
  })
})
