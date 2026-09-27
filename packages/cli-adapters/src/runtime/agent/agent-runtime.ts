import type {
  Message,
  AgentEndpointId,
  AgentRuntimeId,
  AgentRosterEntry,
  PeerAgentMessageResult,
  AgentRunSpec,
  RuntimeContinuation,
  Session,
  PlannotatorReviewDecision,
  ExplanationPayload,
  QuestionAnswer,
  QuestionRequest,
  StreamEvent,
  SubagentFleetControlOutcome,
  SubagentFleetControlRequest,
  SubagentFleetSnapshot
} from "@jingler/core"
import { piEndpointId } from "@jingler/core"
import { Context, Data, Effect, Layer, Stream } from "effect"
import type { ToolRegistry } from "../tools/tool-registry.js"
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

export interface AgentRuntimeContext {
  /** Jingler-owned planning tools, bound to the current chat. */
  readonly isPlanReviewPending?: () => boolean
  readonly planning?: {
    readonly register: (registry: ToolRegistry, context: AgentRuntimeContext) => void
    readonly attachRegistry: (registry: ToolRegistry) => void
    readonly execute: (filePath: string, submit: boolean, signal: AbortSignal) => Promise<unknown>
  }
  /** Main-process-only capability attachments for this run. */
  readonly mcp?: JinglerMcpAttachments
  /** Publish Jingler-owned lifecycle events produced by first-class tools. */
  readonly publishEvent: (event: StreamEvent) => Effect.Effect<void>
  /** Publish a task-local stop handle for the background-task dock. */
  readonly registerBackgroundStop: (stop: RuntimeBackgroundStop) => Effect.Effect<void>
  readonly canUseTool: (
    request: RuntimePermissionRequest
  ) => Effect.Effect<RuntimePermissionDecision>
  readonly askQuestion: (request: QuestionRequest) => Effect.Effect<ReadonlyArray<QuestionAnswer>>
  /** Publish or replace the session's focused visual explanation. */
  readonly publishExplanation?: (explanation: ExplanationPayload) => Effect.Effect<void, Error>
  readonly listPeerAgents?: () => Effect.Effect<ReadonlyArray<AgentRosterEntry>>
  readonly messagePeerAgent?: (
    targetChatId: string,
    text: string
  ) => Effect.Effect<PeerAgentMessageResult>
}

export interface AgentRuntimeOwner {
  readonly runtimeId: AgentRuntimeId
  readonly endpointId: AgentEndpointId
  readonly targetId: string
}

export const runtimeOwnerForSession = (
  session: Session,
  chatId: string
): AgentRuntimeOwner | null => {
  const chat = session.chats.find((candidate) => candidate.id === chatId)
  const runtimeId = chat?.runtimeId ?? session.runtimeId ?? "pi"
  const targetId = session.environmentId ?? "desktop"
  const connectionId = chat?.connectionId ?? session.connectionId
  const endpointId = chat?.endpointId ?? session.endpointId ?? (
    runtimeId === "pi" && connectionId !== undefined
      ? piEndpointId(targetId, connectionId)
      : undefined
  )
  return endpointId === undefined ? null : { runtimeId, endpointId, targetId }
}

export interface AgentRuntimeShape {
  readonly run: (
    spec: AgentRunSpec,
    context: AgentRuntimeContext
  ) => Stream.Stream<StreamEvent, AgentRuntimeError>
  readonly steer: (
    continuation: RuntimeContinuation,
    targetId: string,
    text: string
  ) => Effect.Effect<void, AgentRuntimeError>
  readonly interrupt: (
    continuation: RuntimeContinuation,
    targetId: string
  ) => Effect.Effect<void, AgentRuntimeError>
  readonly controlSubagent: (
    owner: AgentRuntimeOwner,
    sessionId: string,
    chatId: string,
    request: SubagentFleetControlRequest
  ) => Effect.Effect<SubagentFleetControlOutcome, AgentRuntimeError>
  /** Deliver the operator's verdict on the chat's pending native plan review. */
  readonly decidePlanReview: (
    owner: AgentRuntimeOwner,
    sessionId: string,
    chatId: string,
    decision: PlannotatorReviewDecision
  ) => Effect.Effect<void, AgentRuntimeError>
  readonly subagentFleetSnapshot: (
    owner: AgentRuntimeOwner,
    sessionId: string,
    chatId: string,
    parentRuntimeSessionId: string
  ) => Effect.Effect<SubagentFleetSnapshot, AgentRuntimeError>
  readonly subagentTranscript: (
    owner: AgentRuntimeOwner,
    sessionId: string,
    chatId: string,
    parentRuntimeSessionId: string,
    runId: string
  ) => Effect.Effect<ReadonlyArray<Message>, AgentRuntimeError>
}

export class AgentRuntime extends Context.Tag("@jingler/AgentRuntime")<
  AgentRuntime,
  AgentRuntimeShape
>() {}

export interface AgentRuntimeRegistration {
  readonly runtimeId: AgentRuntimeId
  readonly runtime: AgentRuntimeShape
  readonly ownsEndpoint: (endpointId: AgentEndpointId, targetId: string) => boolean
}

export interface AgentRuntimeRegistryShape {
  readonly registrations: ReadonlyMap<AgentRuntimeId, AgentRuntimeRegistration>
}

export class AgentRuntimeRegistry extends Context.Tag("@jingler/AgentRuntimeRegistry")<
  AgentRuntimeRegistry,
  AgentRuntimeRegistryShape
>() {}

const unavailableRuntime = (runtimeId: AgentRuntimeId): AgentRuntimeError =>
  new AgentRuntimeError({
    reason: "runtime",
    message: `Agent runtime is unavailable: ${runtimeId}`
  })

const incompatibleEndpoint = (
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  targetId: string
): AgentRuntimeError =>
  new AgentRuntimeError({
    reason: "incompatible-target",
    message: `Endpoint ${endpointId} is not owned by ${runtimeId} on target ${targetId}`
  })

export const makeAgentRuntimeRegistry = (
  registrations: ReadonlyArray<AgentRuntimeRegistration>
): AgentRuntimeRegistryShape => ({
  registrations: new Map(registrations.map((entry) => [entry.runtimeId, entry]))
})

export const makeAgentRuntimeRouter = (
  registry: AgentRuntimeRegistryShape
): AgentRuntimeShape => {
  const registrationFor = (runtimeId: AgentRuntimeId) =>
    registry.registrations.get(runtimeId)

  const ownedRegistration = (
    runtimeId: AgentRuntimeId,
    endpointId: AgentEndpointId,
    targetId: string
  ): Effect.Effect<AgentRuntimeRegistration, AgentRuntimeError> => {
    const registration = registrationFor(runtimeId)
    if (registration === undefined) return Effect.fail(unavailableRuntime(runtimeId))
    return registration.ownsEndpoint(endpointId, targetId)
      ? Effect.succeed(registration)
      : Effect.fail(incompatibleEndpoint(runtimeId, endpointId, targetId))
  }

  return {
    run: (spec, context) => {
      if (
        spec.continuation !== null &&
        (spec.continuation.runtimeId !== spec.runtimeId ||
          spec.continuation.endpointId !== spec.endpointId)
      ) {
        return Stream.fail(incompatibleEndpoint(
          spec.runtimeId,
          spec.endpointId,
          spec.targetCapabilities.targetId
        ))
      }
      return Stream.unwrap(
        ownedRegistration(
          spec.runtimeId,
          spec.endpointId,
          spec.targetCapabilities.targetId
        ).pipe(Effect.map(({ runtime }) => runtime.run(spec, context)))
      )
    },
    steer: (continuation, targetId, text) =>
      ownedRegistration(continuation.runtimeId, continuation.endpointId, targetId).pipe(
        Effect.flatMap(({ runtime }) => runtime.steer(continuation, targetId, text))
      ),
    interrupt: (continuation, targetId) =>
      ownedRegistration(continuation.runtimeId, continuation.endpointId, targetId).pipe(
        Effect.flatMap(({ runtime }) => runtime.interrupt(continuation, targetId))
      ),
    controlSubagent: (owner, ...args) => ownedRegistration(
      owner.runtimeId,
      owner.endpointId,
      owner.targetId
    ).pipe(Effect.flatMap(({ runtime }) => runtime.controlSubagent(owner, ...args))),
    decidePlanReview: (owner, ...args) => ownedRegistration(
      owner.runtimeId,
      owner.endpointId,
      owner.targetId
    ).pipe(Effect.flatMap(({ runtime }) => runtime.decidePlanReview(owner, ...args))),
    subagentFleetSnapshot: (owner, ...args) => ownedRegistration(
      owner.runtimeId,
      owner.endpointId,
      owner.targetId
    ).pipe(Effect.flatMap(({ runtime }) => runtime.subagentFleetSnapshot(owner, ...args))),
    subagentTranscript: (owner, ...args) => ownedRegistration(
      owner.runtimeId,
      owner.endpointId,
      owner.targetId
    ).pipe(Effect.flatMap(({ runtime }) => runtime.subagentTranscript(owner, ...args)))
  }
}

export const AgentRuntimeRouterLive = Layer.effect(
  AgentRuntime,
  Effect.map(AgentRuntimeRegistry, makeAgentRuntimeRouter)
)
