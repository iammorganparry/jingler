import { Schema } from "effect"

/** The one public Jingler supervision contract. */
export const SUBAGENT_FLEET_PROTOCOL_VERSION = 2 as const

export const SubagentFleetMessageId = Schema.String
export type SubagentFleetMessageId = Schema.Schema.Type<typeof SubagentFleetMessageId>

export const SubagentFleetStatus = Schema.Literal(
  "queued",
  "running",
  "paused",
  "needs-attention",
  "completed",
  "failed",
  "stopped",
  "unknown"
)
export type SubagentFleetStatus = Schema.Schema.Type<typeof SubagentFleetStatus>

export const SubagentFleetNodeKind = Schema.Literal("agent", "workflow")
export type SubagentFleetNodeKind = Schema.Schema.Type<typeof SubagentFleetNodeKind>

export const SubagentFleetHealth = Schema.Literal(
  "connected",
  "stale",
  "disconnected",
  "unknown"
)
export type SubagentFleetHealth = Schema.Schema.Type<typeof SubagentFleetHealth>

export const SubagentFleetUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  costUsd: Schema.Number,
  durationMs: Schema.Number,
  toolCalls: Schema.Number
})
export type SubagentFleetUsage = Schema.Schema.Type<typeof SubagentFleetUsage>

export const SubagentFleetArtifact = Schema.Struct({
  kind: Schema.Literal("result", "report", "transcript", "output"),
  path: Schema.String,
  label: Schema.String
})
export type SubagentFleetArtifact = Schema.Schema.Type<typeof SubagentFleetArtifact>

export const SubagentFleetBlocking = Schema.Struct({
  reason: Schema.String,
  message: Schema.String,
  since: Schema.Number
})
export type SubagentFleetBlocking = Schema.Schema.Type<typeof SubagentFleetBlocking>

export const SubagentFleetTerminal = Schema.Struct({
  reason: Schema.Literal("completed", "failed", "stopped", "timed-out", "unknown"),
  summary: Schema.String,
  at: Schema.Number,
  retryable: Schema.Boolean
})
export type SubagentFleetTerminal = Schema.Schema.Type<typeof SubagentFleetTerminal>

export const SubagentFleetAttentionReason = Schema.Literal(
  "need_decision",
  "interview_request"
)
export type SubagentFleetAttentionReason = Schema.Schema.Type<
  typeof SubagentFleetAttentionReason
>

export const SubagentFleetAttention = Schema.Struct({
  requestId: SubagentFleetMessageId,
  reason: SubagentFleetAttentionReason,
  message: Schema.String,
  requestedAt: Schema.Number,
  deadlineAt: Schema.NullOr(Schema.Number)
})
export type SubagentFleetAttention = Schema.Schema.Type<typeof SubagentFleetAttention>

export const SubagentFleetNode = Schema.Struct({
  id: Schema.String,
  /** Canonical child identity shared by live, durable, completion, and transcript paths. */
  subagentId: Schema.String,
  /** The orchestration/run that owns this node. */
  orchestrationRunId: Schema.String,
  nodeKind: SubagentFleetNodeKind,
  registryRevision: Schema.Number,
  childSequence: Schema.Number,
  runId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  parentPiSessionId: Schema.String,
  agent: Schema.String,
  task: Schema.String,
  model: Schema.NullOr(Schema.String),
  status: SubagentFleetStatus,
  health: SubagentFleetHealth,
  phase: Schema.NullOr(Schema.String),
  blocking: Schema.NullOr(SubagentFleetBlocking),
  terminal: Schema.NullOr(SubagentFleetTerminal),
  background: Schema.Boolean,
  sessionFile: Schema.NullOr(Schema.String),
  currentTool: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  usage: SubagentFleetUsage,
  artifacts: Schema.Array(SubagentFleetArtifact),
  attention: Schema.NullOr(SubagentFleetAttention)
})
export type SubagentFleetNode = Schema.Schema.Type<typeof SubagentFleetNode>

export const subagentFleetNodeId = (
  parentPiSessionId: string,
  subagentId: string
): string => `${parentPiSessionId}/${encodeURIComponent(subagentId)}`

export const SubagentFleetSnapshot = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  parentPiSessionId: Schema.String,
  registryRevision: Schema.Number,
  generatedAt: Schema.Number,
  totalActive: Schema.Number,
  omitted: Schema.Number,
  activeCapacity: Schema.Struct({ used: Schema.Number, limit: Schema.Number }),
  nodes: Schema.Array(SubagentFleetNode)
})
export type SubagentFleetSnapshot = Schema.Schema.Type<typeof SubagentFleetSnapshot>

export const SubagentFleetEvent = Schema.Union(
  Schema.TaggedStruct("Snapshot", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: SubagentFleetMessageId,
    occurredAt: Schema.Number,
    snapshot: SubagentFleetSnapshot
  }),
  Schema.TaggedStruct("Upsert", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: SubagentFleetMessageId,
    occurredAt: Schema.Number,
    node: SubagentFleetNode
  }),
  Schema.TaggedStruct("Remove", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: SubagentFleetMessageId,
    occurredAt: Schema.Number,
    registryRevision: Schema.Number,
    id: Schema.String
  })
)
export type SubagentFleetEvent = Schema.Schema.Type<typeof SubagentFleetEvent>

export const SubagentFleetControlAction = Schema.Literal(
  "steer",
  "follow-up",
  "interrupt",
  "stop",
  "resume",
  "reply"
)
export type SubagentFleetControlAction = Schema.Schema.Type<
  typeof SubagentFleetControlAction
>

export const SubagentFleetControlRequest = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  requestId: SubagentFleetMessageId,
  parentPiSessionId: Schema.String,
  runId: Schema.String,
  action: SubagentFleetControlAction,
  message: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(SubagentFleetMessageId)
})
export type SubagentFleetControlRequest = Schema.Schema.Type<
  typeof SubagentFleetControlRequest
>

export const SubagentControlDeliveryStatus = Schema.Literal(
  "queued",
  "accepted",
  "delivered",
  "observed",
  "applied",
  "rejected",
  "cancelled",
  "expired"
)
export type SubagentControlDeliveryStatus = Schema.Schema.Type<
  typeof SubagentControlDeliveryStatus
>

export const SubagentFleetControlOutcome = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  requestId: SubagentFleetMessageId,
  runId: Schema.String,
  action: SubagentFleetControlAction,
  acknowledged: Schema.Boolean,
  status: Schema.Literal("accepted", "rejected", "not-found", "invalid-state"),
  deliveryStatus: SubagentControlDeliveryStatus,
  sequence: Schema.Number,
  nativeRequestId: Schema.NullOr(Schema.String),
  message: Schema.String,
  acknowledgedAt: Schema.Number
})
export type SubagentFleetControlOutcome = Schema.Schema.Type<
  typeof SubagentFleetControlOutcome
>

export const SubagentSupervisorStatus = Schema.Literal(
  "running",
  "paused",
  "stopping",
  "completed"
)

export const SubagentSiblingSummary = Schema.Struct({
  subagentId: Schema.String,
  agent: Schema.String,
  task: Schema.String,
  status: SubagentFleetStatus,
  phase: Schema.NullOr(Schema.String),
  outputAvailable: Schema.Boolean
})

export const SubagentSupervisorSnapshot = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  parentPiSessionId: Schema.String,
  registryRevision: Schema.Number,
  status: SubagentSupervisorStatus,
  goalRevision: Schema.Number,
  phase: Schema.NullOr(Schema.String),
  siblings: Schema.Array(SubagentSiblingSummary),
  generatedAt: Schema.Number
})
export type SubagentSupervisorSnapshot = Schema.Schema.Type<
  typeof SubagentSupervisorSnapshot
>

export const SubagentChildStateEvent = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  eventId: SubagentFleetMessageId,
  parentPiSessionId: Schema.String,
  subagentId: Schema.String,
  orchestrationRunId: Schema.String,
  childSequence: Schema.Number,
  occurredAt: Schema.Number,
  status: SubagentFleetStatus,
  health: SubagentFleetHealth,
  phase: Schema.NullOr(Schema.String),
  currentTool: Schema.NullOr(Schema.String),
  blocking: Schema.NullOr(SubagentFleetBlocking),
  terminal: Schema.NullOr(SubagentFleetTerminal)
})
export type SubagentChildStateEvent = Schema.Schema.Type<typeof SubagentChildStateEvent>

export const SubagentControlEnvelope = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  messageId: SubagentFleetMessageId,
  idempotencyKey: Schema.String,
  parentPiSessionId: Schema.String,
  subagentId: Schema.String,
  orchestrationRunId: Schema.String,
  sequence: Schema.Number,
  action: SubagentFleetControlAction,
  message: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(SubagentFleetMessageId),
  createdAt: Schema.Number,
  deadlineAt: Schema.NullOr(Schema.Number)
})
export type SubagentControlEnvelope = Schema.Schema.Type<typeof SubagentControlEnvelope>

export const SubagentControlReceipt = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  messageId: SubagentFleetMessageId,
  parentPiSessionId: Schema.String,
  subagentId: Schema.String,
  sequence: Schema.Number,
  status: SubagentControlDeliveryStatus,
  occurredAt: Schema.Number,
  message: Schema.NullOr(Schema.String)
})
export type SubagentControlReceipt = Schema.Schema.Type<typeof SubagentControlReceipt>

export const SubagentAttentionRequest = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  requestId: SubagentFleetMessageId,
  parentPiSessionId: Schema.String,
  subagentId: Schema.String,
  orchestrationRunId: Schema.String,
  reason: SubagentFleetAttentionReason,
  message: Schema.String,
  createdAt: Schema.Number,
  deadlineAt: Schema.NullOr(Schema.Number)
})
export type SubagentAttentionRequest = Schema.Schema.Type<typeof SubagentAttentionRequest>

export const SubagentAttentionReply = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  requestId: SubagentFleetMessageId,
  messageId: SubagentFleetMessageId,
  parentPiSessionId: Schema.String,
  subagentId: Schema.String,
  message: Schema.String,
  createdAt: Schema.Number
})
export type SubagentAttentionReply = Schema.Schema.Type<typeof SubagentAttentionReply>
