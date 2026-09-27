import { AgentRunError, type RuntimeContinuation, type UsageFact, type StreamEvent } from "@jingler/core"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  type AgentContext,
  AgentTurnDriver,
  type AgentTurnSpec
} from "../../agent-turn-driver.js"
import { requiresPreparedTurn } from "../resources/portable-runtime.js"
import { AgentRuntime } from "./agent-runtime.js"

const runtimeFailure = (spec: AgentTurnSpec, message: string): AgentRunError =>
  new AgentRunError({ kind: spec.connectionId ?? spec.runtimeId, message })

const runtimeContext = (spec: AgentTurnSpec, context: AgentContext) => ({
  ...(spec.mcp === undefined ? {} : { mcp: spec.mcp }),
  publishEvent: context.emit,
  recordUsage: context.recordUsage,
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

const usageFactFor = (
  runId: string,
  spec: ReturnType<typeof piSpec>,
  startedAt: number,
  event: StreamEvent
): UsageFact | null => {
  if (event._tag !== "Done" && event._tag !== "Failed") return null
  return {
    id: `${runId}:parent`,
    runId,
    sessionId: spec.sessionId,
    chatId: spec.chatId,
    parentRunId: null,
    runtimeId: spec.runtimeId,
    providerId: spec.providerId ?? null,
    modelId: String(spec.modelId),
    kind: "parent",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: event._tag === "Done" ? event.tokens : null,
    // OpenCode reports message cost. PI can be API or subscription-backed, so
    // its generic terminal event cannot prove whether a numeric zero is known.
    costUsd: event._tag === "Done" && spec.runtimeId === "opencode"
      ? event.costUsd
      : null,
    toolCalls: null,
    outcome: event._tag === "Done" ? "success" : "error",
    provenance: `${spec.runtimeId}.stream`
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
        const startedAt = Date.now()
        let recorded = false
        const runContext = runtimeContext(spec, context)
        return runtime.run(canonical, runContext).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const fact = recorded ? null : usageFactFor(runId, canonical, startedAt, event)
              if (fact !== null) {
                recorded = true
                yield* runContext.recordUsage?.(fact) ?? Effect.void
              }
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
                  images.length > 0 || requiresPreparedTurn(text)
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
          Effect.onInterrupt(() => Effect.gen(function* () {
            if (!recorded) {
              const fact = usageFactFor(
                runId,
                canonical,
                startedAt,
                { _tag: "Failed", message: "Turn cancelled" }
              )
              if (fact !== null) {
                recorded = true
                yield* (runContext.recordUsage?.({
                  ...fact,
                  outcome: "cancelled",
                  provenance: `${canonical.runtimeId}.interrupt`
                }) ?? Effect.void)
              }
            }
            yield* interruptRun(runId).pipe(Effect.ignore)
          })),
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
