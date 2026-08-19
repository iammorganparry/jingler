import { AgentRunError } from "@jingler/core"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentContext,
  AgentTurnDriver,
  PlanDecision,
  type AgentTurnSpec
} from "../../agent-turn-driver.js"
import { AgentRuntime } from "./agent-runtime.js"

const runtimeFailure = (spec: AgentTurnSpec, message: string): AgentRunError =>
  new AgentRunError({ kind: spec.connectionId, message })

const runtimeContext = (spec: AgentTurnSpec, context: AgentContext) => ({
  ...(spec.mcp === undefined ? {} : { mcp: spec.mcp }),
  ...(spec.memoryAttachmentStatus === undefined
    ? {}
    : { memoryAttachmentStatus: spec.memoryAttachmentStatus }),
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
  saveDraftPlan: (plan: Parameters<NonNullable<AgentContext["saveDraftPlan"]>>[0]) =>
    context.saveDraftPlan?.(plan) ?? Effect.void,
  discardPlan: () => context.discardPlan?.() ?? Effect.void,
  proposePlan: (plan: Parameters<AgentContext["proposePlan"]>[0]) =>
    context.proposePlan(plan).pipe(
      Effect.map((decision) =>
        PlanDecision.$is("Approve")(decision)
          ? {
              _tag: "Approve" as const,
              mode: decision.mode,
              plan: decision.plan
            }
          : PlanDecision.$is("Revise")(decision)
            ? { _tag: "Revise" as const, feedback: decision.feedback }
            : { _tag: "Reject" as const }
      )
    )
})

const piSpec = (runId: string, spec: AgentTurnSpec) => {
  const {
    images: _images,
    mcp: _mcp,
    memoryAttachmentStatus: _memoryAttachmentStatus,
    ...runtime
  } = spec
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
    const active = yield* Ref.make(new Map<string, string>())
    const interruptRun = (runId: string) =>
      Ref.get(active).pipe(
        Effect.flatMap((current) => {
          const piSessionId = current.get(runId)
          return piSessionId === undefined ? Effect.void : runtime.interrupt(piSessionId)
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
                yield* Ref.update(active, (current) => new Map(current).set(runId, event.sessionId))
                // Pi's steer channel is text-only, and that will not change
                // mid-run: `deferred` here left an image-bearing "Send now"
                // silently retrying forever. `unsupported` hands it to the
                // stop-and-replay fallback, whose fresh turn carries images.
                yield* context.registerTurnSteer?.((text, images) =>
                  images.length > 0
                    ? Promise.resolve("unsupported")
                    : Effect.runPromise(runtime.steer(event.sessionId, text)).then(
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
