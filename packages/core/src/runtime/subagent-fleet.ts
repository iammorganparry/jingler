import { Schema } from "effect"

export const SUBAGENT_FLEET_PROTOCOL_VERSION = 1 as const

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
export type SubagentFleetArtifact = Schema.Schema.Type<
  typeof SubagentFleetArtifact
>

export const SubagentFleetAttention = Schema.Struct({
  requestId: Schema.String,
  reason: Schema.Literal("need_decision", "interview_request"),
  message: Schema.String,
  requestedAt: Schema.Number
})
export type SubagentFleetAttention = Schema.Schema.Type<
  typeof SubagentFleetAttention
>

export const SubagentFleetNode = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  parentPiSessionId: Schema.String,
  agent: Schema.String,
  task: Schema.String,
  model: Schema.NullOr(Schema.String),
  status: SubagentFleetStatus,
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

export const SubagentFleetSnapshot = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  parentPiSessionId: Schema.String,
  generatedAt: Schema.Number,
  totalActive: Schema.Number,
  omitted: Schema.Number,
  activeCapacity: Schema.Struct({ used: Schema.Number, limit: Schema.Number }),
  nodes: Schema.Array(SubagentFleetNode)
})
export type SubagentFleetSnapshot = Schema.Schema.Type<
  typeof SubagentFleetSnapshot
>

export const SubagentFleetEvent = Schema.Union(
  Schema.TaggedStruct("Snapshot", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: Schema.String,
    occurredAt: Schema.Number,
    snapshot: SubagentFleetSnapshot
  }),
  Schema.TaggedStruct("Upsert", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: Schema.String,
    occurredAt: Schema.Number,
    node: SubagentFleetNode
  }),
  Schema.TaggedStruct("Remove", {
    version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
    eventId: Schema.String,
    occurredAt: Schema.Number,
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
  requestId: Schema.String,
  parentPiSessionId: Schema.String,
  runId: Schema.String,
  action: SubagentFleetControlAction,
  message: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(Schema.String)
})
export type SubagentFleetControlRequest = Schema.Schema.Type<
  typeof SubagentFleetControlRequest
>

export const SubagentFleetControlOutcome = Schema.Struct({
  version: Schema.Literal(SUBAGENT_FLEET_PROTOCOL_VERSION),
  requestId: Schema.String,
  runId: Schema.String,
  action: SubagentFleetControlAction,
  acknowledged: Schema.Boolean,
  status: Schema.Literal("accepted", "rejected", "not-found", "invalid-state"),
  message: Schema.String,
  acknowledgedAt: Schema.Number
})
export type SubagentFleetControlOutcome = Schema.Schema.Type<
  typeof SubagentFleetControlOutcome
>
