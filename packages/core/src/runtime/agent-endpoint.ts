import { Schema } from "effect"
import {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "./provider-connection.js"

export const AgentRuntimeId = Schema.Literal("pi", "claude", "codex", "opencode")
export type AgentRuntimeId = Schema.Schema.Type<typeof AgentRuntimeId>

export const AgentEndpointId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.brand("AgentEndpointId")
)
export type AgentEndpointId = Schema.Schema.Type<typeof AgentEndpointId>

export const piEndpointId = (
  targetId: string,
  connectionId: ProviderConnectionId
): AgentEndpointId => AgentEndpointId.make(`${targetId}:pi:${connectionId}`)

export const piEndpointTargets = (
  endpointId: AgentEndpointId,
  targetId: string
): boolean => endpointId.startsWith(`${targetId}:pi:`)

export const nativeCliEndpointId = (
  targetId: string,
  runtimeId: Exclude<AgentRuntimeId, "pi">,
  profile = "default"
): AgentEndpointId => AgentEndpointId.make(`${targetId}:${runtimeId}:${profile}`)

export const nativeCliEndpointTargets = (
  endpointId: AgentEndpointId,
  runtimeId: Exclude<AgentRuntimeId, "pi">,
  targetId: string
): boolean => endpointId.startsWith(`${targetId}:${runtimeId}:`)

export const providerConnectionIdForPiEndpoint = (
  endpointId: AgentEndpointId,
  targetId: string
): ProviderConnectionId | null => {
  const prefix = `${targetId}:pi:`
  return endpointId.startsWith(prefix) && endpointId.length > prefix.length
    ? ProviderConnectionId.make(endpointId.slice(prefix.length))
    : null
}

export const AgentRuntimeFeatures = Schema.Struct({
  steer: Schema.Literal("none", "text", "multimodal"),
  planReview: Schema.Boolean,
  subagentFleet: Schema.Boolean,
  backgroundTasks: Schema.Boolean
})
export type AgentRuntimeFeatures = Schema.Schema.Type<typeof AgentRuntimeFeatures>

export const AgentModelSelection = Schema.Struct({
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  providerId: ProviderId,
  modelId: ProviderModelId
})
export type AgentModelSelection = Schema.Schema.Type<typeof AgentModelSelection>

export const SetSessionAgentModelInput = Schema.Struct({
  sessionId: Schema.String,
  chatId: Schema.String,
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  providerId: ProviderId,
  modelId: ProviderModelId
})
export type SetSessionAgentModelInput = Schema.Schema.Type<typeof SetSessionAgentModelInput>

export const RuntimeContinuation = Schema.Struct({
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  id: Schema.String.pipe(Schema.minLength(1))
})
export type RuntimeContinuation = Schema.Schema.Type<typeof RuntimeContinuation>

export const AgentEndpointStatus = Schema.Literal(
  "ready",
  "signed-out",
  "missing",
  "unsupported",
  "error",
  "stale-agent"
)
export type AgentEndpointStatus = Schema.Schema.Type<typeof AgentEndpointStatus>

export const AgentEndpoint = Schema.Struct({
  id: AgentEndpointId,
  runtimeId: AgentRuntimeId,
  targetId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  status: AgentEndpointStatus,
  version: Schema.NullOr(Schema.String.pipe(Schema.maxLength(128))),
  protocolVersion: Schema.optional(Schema.String.pipe(Schema.maxLength(128))),
  features: AgentRuntimeFeatures
})
export type AgentEndpoint = Schema.Schema.Type<typeof AgentEndpoint>

export const SessionRuntimeIdentity = Schema.Struct({
  runtimeId: Schema.NullOr(AgentRuntimeId),
  endpointId: Schema.NullOr(AgentEndpointId),
  connectionId: Schema.NullOr(ProviderConnectionId),
  providerId: Schema.NullOr(ProviderId),
  modelId: Schema.NullOr(ProviderModelId),
  continuation: Schema.NullOr(RuntimeContinuation),
  modelSelectionRequired: Schema.Boolean,
  connectionSelectionRequired: Schema.Boolean,
  legacyCli: Schema.NullOr(Schema.String),
  legacyModel: Schema.NullOr(Schema.String),
  legacyResumeId: Schema.NullOr(Schema.String)
})
export type SessionRuntimeIdentity = Schema.Schema.Type<typeof SessionRuntimeIdentity>
