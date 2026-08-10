import type {
  PermissionMode,
  PiRunSpec,
  Plan,
  PlanPrd,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent
} from "@jingler/core"
import { Context, Data, type Effect, type Stream } from "effect"

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

export interface RuntimePermissionRequest {
  readonly toolId: string
  readonly risk: "network" | "mutate" | "execute"
}

export type RuntimePermissionDecision = "allow" | "deny"

export type RuntimePlanDecision =
  | { readonly _tag: "Approve"; readonly mode: PermissionMode; readonly plan?: Plan }
  | { readonly _tag: "Revise"; readonly feedback: string }
  | { readonly _tag: "Reject" }

export interface AgentRuntimeContext {
  readonly canUseTool: (
    request: RuntimePermissionRequest
  ) => Effect.Effect<RuntimePermissionDecision>
  readonly askQuestion: (
    request: QuestionRequest
  ) => Effect.Effect<ReadonlyArray<QuestionAnswer>>
  readonly saveDraftPlan: (plan: PlanPrd) => Effect.Effect<void>
  readonly proposePlan: (plan: PlanPrd) => Effect.Effect<RuntimePlanDecision>
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
