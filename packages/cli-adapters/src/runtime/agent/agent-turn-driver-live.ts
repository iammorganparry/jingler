import { AgentRunError, type RuntimeContinuation } from "@jingler/core"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentContext,
  AgentTurnDriver,
  type AgentTurnSpec
} from "../../agent-turn-driver.js"
import { AgentRuntime } from "./agent-runtime.js"

const runtimeFailure = (spec: AgentTurnSpec, message: string): AgentRunError =>
  new AgentRunError({ kind: spec.connectionId ?? spec.runtimeId, message })

const runtimeContext = (spec: AgentTurnSpec, context: AgentContext) => ({
  ...(spec.mcp === undefined ? {} : { mcp: spec.mcp }),
  publishEvent: context.emit,
  registerBackgroundStop: context.registerBackgroundStop,
  canUseTool: (request: {
    readonly toolId: string
    readonly risk: "network" | "mutate" | "execute"
  }) =>
    context.canUseTool({
      kind: request.risk === "mutate" ? "edit" : "command",
      tool: request.toolId,
      target: null,
      command: null
    }),
  askQuestion: context.askQuestion,
  publishExplanation: (explanation: Parameters<NonNullable<AgentContext["publishExplanation"]>>[0]) =>
    context.publishExplanation?.(explanation) ?? Effect.void,
  listPeerAgents: context.listPeerAgents,
  messagePeerAgent: context.messagePeerAgent
})

const piSpec = (runId: string, spec: AgentTurnSpec) => {
  const { mcp: _mcp, ...runtime } = spec
  return {
    runId,
    ...runtime
  }
}

/**
 * Transitional caller seam: existing orchestration keeps its event sink while
 * all production inference and tool execution goes through AgentRuntime.
 */
export const AgentTurnDriverLive = Layer.effect(
  AgentTurnDriver,
  Effect.gen(function* () {
    const runtime = yield* AgentRuntime
    const active = yield* Ref.make(new Map<
      string,
      { readonly continuation: RuntimeContinuation; readonly targetId: string }
    >())
    const interruptRun = (runId: string) =>
      Ref.get(active).pipe(
        Effect.flatMap((current) => {
          const activeRun = current.get(runId)
          return activeRun === undefined
            ? Effect.void
            : runtime.interrupt(activeRun.continuation, activeRun.targetId)
        }),
        Effect.mapError(
          (error) => new AgentRunError({ kind: "runtime", message: error.message })
        )
      )

    return AgentTurnDriver.of({
      run: (runId, spec, context) => {
        const canonical = piSpec(runId, spec)
        return runtime.run(canonical, runtimeContext(spec, context)).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event._tag === "Started") {
                const continuation: RuntimeContinuation = {
                  runtimeId: canonical.runtimeId,
                  endpointId: canonical.endpointId,
                  id: event.sessionId
                }
                const targetId = canonical.targetCapabilities.targetId
                yield* Ref.update(active, (current) =>
                  new Map(current).set(runId, { continuation, targetId })
                )
                // Pi's steer channel is text-only, and that will not change
                // mid-run: `deferred` here left an image-bearing "Send now"
                // silently retrying forever. `unsupported` hands it to the
                // stop-and-replay fallback, whose fresh turn carries images.
                yield* context.registerTurnSteer?.((text, images) =>
                  images.length > 0
                    ? Promise.resolve("unsupported")
                    : Effect.runPromise(runtime.steer(continuation, targetId, text)).then(
                        () => "accepted" as const,
                        () => "deferred" as const
                      )
                ) ?? Effect.void
              }
              yield* context.emit(event)
            })
          ),
          Effect.mapError((error) => runtimeFailure(spec, error.message)),
          Effect.onInterrupt(() => interruptRun(runId).pipe(Effect.ignore)),
          Effect.ensuring(context.registerTurnSteer?.(null) ?? Effect.void),
          Effect.ensuring(
            Ref.update(active, (current) => {
              const next = new Map(current)
              next.delete(runId)
              return next
            })
          )
        )
      },
      stop: interruptRun
    })
  })
)
