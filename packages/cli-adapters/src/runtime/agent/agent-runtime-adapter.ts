import { CliExecError } from "@jingler/core"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentContext,
  CliAdapter,
  PlanDecision,
  type SessionSpec
} from "../../adapter.js"
import { AgentRuntime } from "./agent-runtime.js"

const missingRuntimeIdentity = (spec: SessionSpec): CliExecError =>
  new CliExecError({
    kind: spec.cli,
    message:
      "This conversation needs a certified provider connection before it can run."
  })

const runtimeFailure = (spec: SessionSpec, message: string): CliExecError =>
  new CliExecError({ kind: spec.cli, message })

const runtimeContext = (context: AgentContext) => ({
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
  proposePlan: (plan: Parameters<AgentContext["proposePlan"]>[0]) =>
    context.proposePlan(plan).pipe(
      Effect.map((decision) =>
        PlanDecision.$is("Approve")(decision)
          ? { _tag: "Approve" as const, mode: decision.mode, plan: decision.plan }
          : PlanDecision.$is("Revise")(decision)
            ? { _tag: "Revise" as const, feedback: decision.feedback }
            : { _tag: "Reject" as const }
      )
    )
})

const piSpec = (spec: SessionSpec) => {
  if (!spec.runtime) return null
  return {
    ...spec.runtime,
    cwd: spec.cwd,
    prompt: spec.prompt,
    mode: spec.readOnly ? "read-only" as const : spec.mode
  }
}

/**
 * Transitional caller seam: existing orchestration keeps its event sink while
 * all production inference and tool execution goes through AgentRuntime.
 */
export const AgentRuntimeAdapterLive = Layer.effect(
  CliAdapter,
  Effect.gen(function* () {
    const runtime = yield* AgentRuntime
    const active = yield* Ref.make(new Map<string, string>())

    return CliAdapter.of({
      run: (runId, spec, context) => {
        const canonical = piSpec(spec)
        if (canonical === null) return Effect.fail(missingRuntimeIdentity(spec))

        return runtime.run(canonical, runtimeContext(context)).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event._tag === "Started") {
                yield* Ref.update(active, (current) =>
                  new Map(current).set(runId, event.sessionId)
                )
                yield* (context.registerTurnSteer?.((text, images) =>
                  images.length > 0
                    ? Promise.resolve("deferred")
                    : Effect.runPromise(runtime.steer(event.sessionId, text)).then(
                        () => "accepted" as const,
                        () => "deferred" as const
                      )
                ) ?? Effect.void)
              }
              yield* context.emit(event)
            })
          ),
          Effect.mapError((error) => runtimeFailure(spec, error.message)),
          Effect.ensuring(
            context.registerTurnSteer?.(null) ?? Effect.void
          ),
          Effect.ensuring(
            Ref.update(active, (current) => {
              const next = new Map(current)
              next.delete(runId)
              return next
            })
          )
        )
      },
      stop: (runId) =>
        Ref.get(active).pipe(
          Effect.flatMap((current) => {
            const piSessionId = current.get(runId)
            return piSessionId === undefined
              ? Effect.void
              : runtime.interrupt(piSessionId)
          }),
          Effect.mapError((error) =>
            new CliExecError({ kind: "unknown", message: error.message })
          )
        )
    })
  })
)
