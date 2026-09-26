import { Schema } from "effect"
import { Attachment, Message } from "../conversation.js"
import { ReasoningSetting } from "../domain.js"
import {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "./provider-connection.js"
import { RuntimeCapabilityManifest } from "./capability-manifest.js"
import {
  AgentEndpointId,
  AgentRuntimeId,
  RuntimeContinuation
} from "./agent-endpoint.js"
export {
  RuntimeCapabilityManifest,
  runtimeCapabilitiesMatch
} from "./capability-manifest.js"

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

export const TranscriptSeed = Schema.Struct({
  reason: TranscriptSeedReason,
  messages: Schema.Array(Message)
})
export type TranscriptSeed = Schema.Schema.Type<typeof TranscriptSeed>

export const AgentRunSpec = Schema.Struct({
  /** One runtime attempt; stable across its journal, diagnostics, and normalized events. */
  runId: Schema.String,
  /** Jingler-owned identity used for journals and restart recovery. */
  sessionId: Schema.String,
  chatId: Schema.String,
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: Schema.optional(ProviderId),
  modelId: ProviderModelId,
  role: AgentRole,
  mode: RuntimeMode,
  /** Optional operator override; omitted preserves pi's model-native default. */
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  cwd: Schema.String,
  prompt: Schema.String,
  /** Operator text before Jingler adds turn instructions; portable commands use this only. */
  operatorPrompt: Schema.optional(Schema.String),
  /** Prepared by Jingler, never by a harness plugin. */
  ponytailMode: Schema.optional(Schema.Literal("off", "lite", "full", "ultra", "review")),
  images: Schema.optional(Schema.Array(Attachment)),
  priorMessages: Schema.Array(Message),
  continuation: Schema.NullOr(RuntimeContinuation),
  seed: Schema.NullOr(TranscriptSeed),
  targetCapabilities: RuntimeCapabilityManifest
})
export type AgentRunSpec = Schema.Schema.Type<typeof AgentRunSpec>
