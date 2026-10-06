import { ReasoningSetting } from "./domain.js"
import { Schema } from "effect"
import { AgentEndpointId, AgentRuntimeId } from "./runtime/agent-endpoint.js"
import { ProviderConnectionId, ProviderId, ProviderModelId } from "./runtime/provider-connection.js"

const Timestamp = Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER))
export const RoutineSchedule = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("once"), at: Timestamp }),
  Schema.Struct({ kind: Schema.Literal("interval"), at: Timestamp, everyMs: Schema.Number.pipe(Schema.int(), Schema.between(1000, 365 * 86400000)) })
)
export const RoutineInput = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  projectId: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100000)),
  baseBranch: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  runtimeId: AgentRuntimeId,
  endpointId: AgentEndpointId,
  connectionId: Schema.optional(ProviderConnectionId),
  providerId: ProviderId,
  modelId: ProviderModelId,
  // Review-safe only: no unattended approval escalation in desktop v1.
  mode: Schema.Literal("ask"),
  reasoning: Schema.NullOr(ReasoningSetting),
  schedule: RoutineSchedule,
  enabled: Schema.Boolean,
  approved: Schema.Literal(true),
  maxDurationMs: Schema.Number.pipe(Schema.int(), Schema.between(1000, 24 * 3600000))
})
export type RoutineInput = Schema.Schema.Type<typeof RoutineInput>
export const Routine = Schema.Struct({
  ...RoutineInput.fields,
  id: Schema.String,
  revision: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  nextAt: Schema.NullOr(Timestamp),
  // Binds saved approval to the machine-local project workflow.
  workflowDigest: Schema.NullOr(Schema.String)
})
export type Routine = Schema.Schema.Type<typeof Routine>
export const RoutineRunStatus = Schema.Literal("claimed", "running", "succeeded", "failed", "needs-attention", "cancelled", "interrupted", "skipped")
export const RoutineRun = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  routineName: Schema.String,
  revision: Schema.String,
  trigger: Schema.Literal("manual", "scheduled"),
  occurrenceAt: Timestamp,
  requestedSessionId: Schema.String.pipe(Schema.pattern(/^s_[A-Za-z0-9_-]{8,120}$/u)),
  sessionId: Schema.NullOr(Schema.String),
  status: RoutineRunStatus,
  message: Schema.String,
  createdAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
  skippedCount: Schema.Number.pipe(Schema.int(), Schema.positive())
})
export type RoutineRun = Schema.Schema.Type<typeof RoutineRun>
export const RoutineDocument = Schema.Struct({ version: Schema.Literal(1), routines: Schema.Array(Routine), runs: Schema.Array(RoutineRun) })
export type RoutineDocument = Schema.Schema.Type<typeof RoutineDocument>
export const routineRunActive = (run: RoutineRun) => run.status === "claimed" || run.status === "running"
