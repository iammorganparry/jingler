import { Schema } from "effect"
import { Message } from "../conversation.js"
import {
  ProviderConnectionId,
  ProviderModelId
} from "./provider-connection.js"
import { RuntimeContractVersions } from "./model-certification.js"

export const AgentRole = Schema.Literal(
  "conversation",
  "plan",
  "plan-execution",
  "review",
  "context-digest",
  "title",
  "background"
)
export type AgentRole = Schema.Schema.Type<typeof AgentRole>

export const RuntimeMode = Schema.Literal(
  "ask",
  "accept-edits",
  "auto",
  "plan",
  "read-only"
)
export type RuntimeMode = Schema.Schema.Type<typeof RuntimeMode>

export const TranscriptSeedReason = Schema.Literal(
  "migration",
  "model-switch",
  "connection-switch"
)
export type TranscriptSeedReason = Schema.Schema.Type<typeof TranscriptSeedReason>

export const RuntimeCapabilityManifest = Schema.Struct({
  versions: RuntimeContractVersions,
  toolIds: Schema.Array(Schema.String),
  resourceIds: Schema.Array(Schema.String),
  targetId: Schema.String
})
export type RuntimeCapabilityManifest = Schema.Schema.Type<typeof RuntimeCapabilityManifest>

export const TranscriptSeed = Schema.Struct({
  reason: TranscriptSeedReason,
  messages: Schema.Array(Message)
})
export type TranscriptSeed = Schema.Schema.Type<typeof TranscriptSeed>

export const PiRunSpec = Schema.Struct({
  connectionId: ProviderConnectionId,
  modelId: ProviderModelId,
  role: AgentRole,
  mode: RuntimeMode,
  cwd: Schema.String,
  prompt: Schema.String,
  priorMessages: Schema.Array(Message),
  piSessionId: Schema.NullOr(Schema.String),
  seed: Schema.NullOr(TranscriptSeed),
  targetCapabilities: RuntimeCapabilityManifest
})
export type PiRunSpec = Schema.Schema.Type<typeof PiRunSpec>

export const runtimeCapabilitiesMatch = (
  expected: RuntimeCapabilityManifest,
  target: RuntimeCapabilityManifest
): boolean =>
  Object.entries(expected.versions).every(
    ([key, value]) => target.versions[key as keyof RuntimeContractVersions] === value
  ) &&
  expected.toolIds.every((id) => target.toolIds.includes(id)) &&
  expected.resourceIds.every((id) => target.resourceIds.includes(id))
