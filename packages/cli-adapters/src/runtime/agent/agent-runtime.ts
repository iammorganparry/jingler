import type {
  Message,
  PermissionMode,
  PiRunSpec,
  ExplanationPayload,
  Plan,
  PlanPrd,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent,
  SubagentFleetControlOutcome,
  SubagentFleetControlRequest,
  SubagentFleetSnapshot
} from "@jingler/core"
import { Context, Data, Effect, type Stream } from "effect"
import type { JinglerMcpAttachments } from "../tools/mcp-tools.js"

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

export type RuntimeBackgroundStop = (taskId: string) => Promise<void>

/** Activity capabilities for roles and tests that cannot launch background work. */
export const inactiveRuntimeActivity = {
  publishEvent: (_event: StreamEvent) => Effect.void,
  registerBackgroundStop: (_stop: RuntimeBackgroundStop) => Effect.void
} satisfies Pick<AgentRuntimeContext, "publishEvent" | "registerBackgroundStop">

export type RuntimePlanDecision =
  | {
      readonly _tag: "Approve"
      readonly mode: PermissionMode
      readonly plan?: Plan
    }
  | { readonly _tag: "Revise"; readonly feedback: string }
  | { readonly _tag: "Reject" }

export interface AgentRuntimeContext {
  /** Main-process-only capability attachments for this run. */
  readonly mcp?: JinglerMcpAttachments
  /** Main-process attachment outcome; failed remains visible without memory tools. */
  readonly memoryAttachmentStatus?: "disabled" | "available" | "failed"
  /** Publish Jingler-owned lifecycle events produced by first-class tools. */
  readonly publishEvent: (event: StreamEvent) => Effect.Effect<void>
  /** Publish a task-local stop handle for the background-task dock. */
  readonly registerBackgroundStop: (stop: RuntimeBackgroundStop) => Effect.Effect<void>
  readonly canUseTool: (
    request: RuntimePermissionRequest
  ) => Effect.Effect<RuntimePermissionDecision>
  readonly askQuestion: (request: QuestionRequest) => Effect.Effect<ReadonlyArray<QuestionAnswer>>
  readonly saveDraftPlan: (plan: PlanPrd) => Effect.Effect<void>
  /** Publish or replace the session's focused visual explanation. */
  readonly publishExplanation?: (explanation: ExplanationPayload) => Effect.Effect<void, Error>
  /** Discard the canonical plan; the next submission proposes fresh. Optional: only `AgentRunner` supplies it. */
  readonly discardPlan?: () => Effect.Effect<void>
  readonly proposePlan: (plan: PlanPrd) => Effect.Effect<RuntimePlanDecision>
}

export interface AgentRuntimeShape {
  readonly run: (
    spec: PiRunSpec,
    context: AgentRuntimeContext
  ) => Stream.Stream<StreamEvent, AgentRuntimeError>
  readonly steer: (piSessionId: string, text: string) => Effect.Effect<void, AgentRuntimeError>
  readonly interrupt: (piSessionId: string) => Effect.Effect<void, AgentRuntimeError>
  readonly controlSubagent: (
    sessionId: string,
    chatId: string,
    request: SubagentFleetControlRequest
  ) => Effect.Effect<SubagentFleetControlOutcome, AgentRuntimeError>
  readonly subagentFleetSnapshot: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string
  ) => Effect.Effect<SubagentFleetSnapshot, AgentRuntimeError>
  readonly subagentTranscript: (
    sessionId: string,
    chatId: string,
    parentPiSessionId: string,
    runId: string
  ) => Effect.Effect<ReadonlyArray<Message>, AgentRuntimeError>
}

export class AgentRuntime extends Context.Tag("@jingler/AgentRuntime")<
  AgentRuntime,
  AgentRuntimeShape
>() {}
