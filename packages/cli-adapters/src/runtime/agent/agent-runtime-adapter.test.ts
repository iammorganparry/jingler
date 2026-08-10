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
  CliAdapter,
  PlanDecision,
  type SessionSpec,
  type SteerTurn
} from "../../adapter.js"
import { AgentRuntime, type AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeAdapterLive } from "./agent-runtime-adapter.js"

const spec = (): SessionSpec => ({
  cli: "claude",
  repo: "jingler",
  branch: "main",
  cwd: "/tmp/jingler",
  prompt: "Inspect the repository",
  images: [],
  binPath: null,
  mode: "ask",
  model: "claude-test",
  resumeId: null,
  runtime: {
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
  effect: Effect.Effect<A, E, CliAdapter>
) =>
  effect.pipe(
    Effect.provide(
      AgentRuntimeAdapterLive.pipe(
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
        Effect.flatMap(CliAdapter, (adapter) =>
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
    expect(emit.mock.calls.map(([event]) => event._tag)).toEqual([
      "Started",
      "Assistant",
      "Done"
    ])
    expect(registerTurnSteer).toHaveBeenCalled()
  })

  it("interrupts the active pi session and refuses missing canonical identity", async () => {
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
    const layer = AgentRuntimeAdapterLive.pipe(
      Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of(runtime)))
    )
    const program = Effect.gen(function* () {
      const adapter = yield* CliAdapter
      const fiber = yield* Effect.fork(adapter.run("run-1", spec(), context()))
      yield* Effect.promise(() => started)
      yield* adapter.stop("run-1")
      release()
      yield* fiber.await
      return yield* Effect.exit(
        adapter.run("missing", { ...spec(), runtime: undefined }, context())
      )
    }).pipe(Effect.provide(layer))

    const missing = await Effect.runPromise(program)
    expect(interrupt).toHaveBeenCalledWith("pi-session")
    expect(missing.toJSON()).toMatchObject({
      _tag: "Failure",
      cause: {
        _tag: "Fail",
        failure: { _tag: "CliExecError" }
      }
    })
  })
})
