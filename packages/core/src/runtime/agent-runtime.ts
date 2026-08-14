import { Schema } from "effect"
import { Message } from "../conversation.js"
import { ReasoningSetting } from "../domain.js"
import {
  ProviderConnectionId,
  ProviderModelId
} from "./provider-connection.js"
import { RuntimeCapabilityManifest } from "./capability-manifest.js"
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

export const PiRunSpec = Schema.Struct({
  /** One runtime attempt; stable across its journal, diagnostics, and normalized events. */
  runId: Schema.String,
  /** Jingler-owned identity used for journals and restart recovery. */
  sessionId: Schema.String,
  chatId: Schema.String,
  connectionId: ProviderConnectionId,
  modelId: ProviderModelId,
  role: AgentRole,
  mode: RuntimeMode,
  /** Optional operator override; omitted preserves pi's model-native default. */
  reasoning: Schema.optional(Schema.NullOr(ReasoningSetting)),
  cwd: Schema.String,
  prompt: Schema.String,
  priorMessages: Schema.Array(Message),
  piSessionId: Schema.NullOr(Schema.String),
  seed: Schema.NullOr(TranscriptSeed),
  targetCapabilities: RuntimeCapabilityManifest
})
export type PiRunSpec = Schema.Schema.Type<typeof PiRunSpec>
