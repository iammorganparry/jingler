import { Schema } from "effect"
import { AuthRouteKind, RuntimeContractVersions } from "./model-certification.js"

export const RuntimeDiagnosticPromptSection = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  estimatedTokens: Schema.Number,
  truncated: Schema.Boolean
})
export type RuntimeDiagnosticPromptSection = Schema.Schema.Type<typeof RuntimeDiagnosticPromptSection>

export const RuntimeDiagnosticMutation = Schema.Struct({
  callId: Schema.String,
  toolId: Schema.String,
  targetCategory: Schema.NullOr(Schema.String),
  status: Schema.Literal("started", "settled", "denied", "cancelled", "failed", "uncertain"),
  fileChangeSetIds: Schema.Array(Schema.String)
})
export type RuntimeDiagnosticMutation = Schema.Schema.Type<typeof RuntimeDiagnosticMutation>

export const RuntimeDiagnosticMcpHealth = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("healthy", "degraded", "closed", "failed")
})
export type RuntimeDiagnosticMcpHealth = Schema.Schema.Type<typeof RuntimeDiagnosticMcpHealth>

export const RuntimeDiagnosticSnapshot = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
  authRoute: Schema.NullOr(AuthRouteKind),
  accountFingerprint: Schema.NullOr(Schema.String),
  versions: RuntimeContractVersions,
  promptHash: Schema.String,
  promptSections: Schema.Array(RuntimeDiagnosticPromptSection),
  activeToolIds: Schema.Array(Schema.String),
  mode: Schema.String,
  retries: Schema.Number,
  mutations: Schema.Array(RuntimeDiagnosticMutation),
  fileChangeStatuses: Schema.Array(Schema.Literal("A", "M", "D", "R")),
  mcpHealth: Schema.Array(RuntimeDiagnosticMcpHealth),
  memory: Schema.optional(Schema.Struct({
    mutatingExecutions: Schema.Number,
    advisories: Schema.Number,
    proposals: Schema.Number,
    workflowPolls: Schema.Number,
    failureCandidates: Schema.Number,
    attachmentStatus: Schema.Literal("disabled", "available", "failed"),
    queuedRetentions: Schema.Number,
    retryingRetentions: Schema.Number
  })),

  terminalCause: Schema.NullOr(Schema.String),
  updatedAt: Schema.String
})
export type RuntimeDiagnosticSnapshot = Schema.Schema.Type<typeof RuntimeDiagnosticSnapshot>
