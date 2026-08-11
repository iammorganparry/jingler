import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderModelId,
  type StreamEvent
} from "@jingler/core"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  type AgentContext,
  AgentTurnDriver,
  PlanDecision,
  type AgentTurnSpec,
  type SteerTurn
} from "../../agent-turn-driver.js"
import { AgentRuntime, type AgentRuntimeShape } from "./agent-runtime.js"
import { AgentTurnDriverLive } from "./agent-turn-driver-live.js"

const spec = (): AgentTurnSpec => ({
  sessionId: "session-1",
  chatId: "chat-1",
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-test"),
  role: "conversation",
  priorMessages: [],
  piSessionId: null,
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
  proposePlan: vi.fn(() => Effect.succeed(PlanDecision.Reject())),
  saveDraftPlan: vi.fn(() => Effect.void),
  registerBackgroundStop: vi.fn(() => Effect.void),
  registerTurnSteer: vi.fn((_steer: SteerTurn | null) => Effect.void)
})

const withRuntime = <A, E>(
  runtime: AgentRuntimeShape,
  effect: Effect.Effect<A, E, AgentTurnDriver>
) =>
  effect.pipe(
    Effect.provide(
      AgentTurnDriverLive.pipe(
        Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of(runtime)))
      )
    )
  )

describe("AgentRuntimeAdapter", () => {
  it("routes the legacy orchestration sink through AgentRuntime", async () => {
    const events: ReadonlyArray<StreamEvent> = [
      { _tag: "Started", sessionId: "pi-session", model: "anthropic/claude-test" },
      { _tag: "Assistant", text: "done" },
      { _tag: "Done", costUsd: 0, tokens: 2 }
    ]
    const run = vi.fn<AgentRuntimeShape["run"]>((_spec, _context) =>
      Stream.fromIterable(events)
    )
    const ctx = context()
    const emit = vi.mocked(ctx.emit)
    const registerTurnSteer = vi.mocked(ctx.registerTurnSteer!)

    await Effect.runPromise(
      withRuntime(
        {
          run,
          steer: () => Effect.void,
          interrupt: () => Effect.void
        },
        Effect.flatMap(AgentTurnDriver, (adapter) =>
          adapter.run("run-1", spec(), ctx)
        )
      )
    )

    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "connection-1",
      modelId: "anthropic/claude-test",
      prompt: "Inspect the repository"
    })
    expect(run.mock.calls[0]?.[1].mcp?.browser?.name).toBe("jingler-browser")
    expect(emit.mock.calls.map(([event]) => event._tag)).toEqual([
      "Started",
      "Assistant",
      "Done"
    ])
    expect(registerTurnSteer).toHaveBeenCalled()
  })

  it("interrupts the active pi session", async () => {
    const interrupt = vi.fn(() => Effect.void)
    let release!: () => void
    let markStarted!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
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
      interrupt
    }
    const layer = AgentTurnDriverLive.pipe(
      Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of(runtime)))
    )
    const program = Effect.gen(function* () {
      const adapter = yield* AgentTurnDriver
      const fiber = yield* Effect.fork(adapter.run("run-1", spec(), context()))
      yield* Effect.promise(() => started)
      yield* adapter.stop("run-1")
      release()
      return yield* fiber.await
    }).pipe(Effect.provide(layer))

    await Effect.runPromise(program)
    expect(interrupt).toHaveBeenCalledWith("pi-session")
  })
})
