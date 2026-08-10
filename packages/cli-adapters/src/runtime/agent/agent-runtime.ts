import type { PiRunSpec, StreamEvent } from "@jingler/core"
import { Context, Data, Effect, Stream } from "effect"

export class AgentRuntimeError extends Data.TaggedError("AgentRuntimeError")<{
  readonly reason:
    | "authentication"
    | "certification"
    | "incompatible-target"
    | "provider"
    | "interrupted"
    | "runtime"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface AgentRuntimeContext {
  readonly canUseTool: (request: unknown) => Effect.Effect<boolean>
  readonly askQuestion: (request: unknown) => Effect.Effect<unknown>
  readonly saveDraftPlan: (plan: unknown) => Effect.Effect<void>
  readonly proposePlan: (plan: unknown) => Effect.Effect<unknown>
}

export interface AgentRuntimeShape {
  readonly run: (
    spec: PiRunSpec,
    context: AgentRuntimeContext
  ) => Stream.Stream<StreamEvent, AgentRuntimeError>
  readonly steer: (
    piSessionId: string,
    text: string
  ) => Effect.Effect<void, AgentRuntimeError>
  readonly interrupt: (
    piSessionId: string
  ) => Effect.Effect<void, AgentRuntimeError>
}

export class AgentRuntime extends Context.Tag("@jingler/AgentRuntime")<
  AgentRuntime,
  AgentRuntimeShape
>() {}
