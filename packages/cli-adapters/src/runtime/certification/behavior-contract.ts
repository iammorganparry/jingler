import {
  AuthRouteKind,
  PlanTaskStatus,
  RuntimeContractVersions,
  type PlanTaskStatus as PlanTaskStatusType,
  type RuntimeContractVersions as RuntimeContractVersionsType
} from "@jingler/core"
import { Schema } from "effect"

export const EvalFileChangeStatus = Schema.Literal("A", "M", "D", "R")
export type EvalFileChangeStatus = Schema.Schema.Type<typeof EvalFileChangeStatus>

export const EvalObservation = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("event"), tag: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool-call"), tool: Schema.String, risk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool-effect"), tool: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("permission"),
    tool: Schema.String,
    decision: Schema.Literal("allow", "deny")
  }),
  Schema.Struct({
    kind: Schema.Literal("file-change"),
    status: EvalFileChangeStatus,
    path: Schema.String,
    oldPath: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ kind: Schema.Literal("auth-route"), route: AuthRouteKind }),
  Schema.Struct({
    kind: Schema.Literal("auth-fallback"),
    from: AuthRouteKind,
    to: AuthRouteKind
  }),
  Schema.Struct({
    kind: Schema.Literal("resource"),
    name: Schema.String,
    state: Schema.Literal("opened", "closed")
  }),
  Schema.Struct({ kind: Schema.Literal("report-text"), text: Schema.String }),
  /**
   * A plan task's PERSISTED status, read back from the canonical plan document
   * after the run settles — the operator-visible truth, not what the agent's
   * prose claimed. Emitted only by runners that execute through the full
   * harness (`AgentRunner` → `PlanStore`).
   */
  Schema.Struct({
    kind: Schema.Literal("plan-task-status"),
    stageId: Schema.String,
    taskId: Schema.String,
    status: PlanTaskStatus
  }),
  /**
   * A plan checkpoint marker the harness dropped (unknown stage/task id). The
   * reason is the harness's own warning text, so matchers can pin the exact
   * drop cause without re-encoding it here.
   */
  Schema.Struct({
    kind: Schema.Literal("plan-marker-dropped"),
    reason: Schema.String
  })
)
export type EvalObservation = Schema.Schema.Type<typeof EvalObservation>

export interface EvalMatcher {
  readonly description: string
  readonly matches: (observation: EvalObservation) => boolean
}

export interface EvalOrdering {
  readonly before: EvalMatcher
  readonly after: EvalMatcher
}

export interface EvalScenario {
  readonly id: string
  readonly capability: string
  readonly required: ReadonlyArray<EvalMatcher>
  readonly forbidden: ReadonlyArray<EvalMatcher>
  readonly ordering: ReadonlyArray<EvalOrdering>
  readonly timeoutMs: number
  readonly requiredVersions: RuntimeContractVersionsType
  /**
   * Minimum matcher score (0..1) for the scenario to pass; omitted means 1
   * (every matcher must hold — the historical behavior). Live model-behavior
   * scenarios lower this for partial credit: a real model that checkpoints
   * four of five tasks regressed less than one that checkpoints none, and a
   * boolean would erase that difference. Hard failures (versions, timeout,
   * terminal-event violations) never pass regardless of this threshold.
   */
  readonly passScore?: number
}

export const EvalTrace = Schema.Struct({
  scenarioId: Schema.String,
  observations: Schema.Array(EvalObservation),
  durationMs: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.Number,
  versions: RuntimeContractVersions
})
export type EvalTrace = Schema.Schema.Type<typeof EvalTrace>

export const event = (tag: string): EvalMatcher => ({
  description: `event:${tag}`,
  matches: (observation) => observation.kind === "event" && observation.tag === tag
})

export const toolEffect = (tool: string): EvalMatcher => ({
  description: `tool-effect:${tool}`,
  matches: (observation) => observation.kind === "tool-effect" && observation.tool === tool
})

export const toolCall = (tool: string): EvalMatcher => ({
  description: `tool-call:${tool}`,
  matches: (observation) => observation.kind === "tool-call" && observation.tool === tool
})

export const permission = (tool: string, decision: "allow" | "deny"): EvalMatcher => ({
  description: `permission:${tool}:${decision}`,
  matches: (observation) =>
    observation.kind === "permission" &&
    observation.tool === tool &&
    observation.decision === decision
})

export const fileChange = (status: EvalFileChangeStatus, path: string): EvalMatcher => ({
  description: `file-change:${status}:${path}`,
  matches: (observation) =>
    observation.kind === "file-change" && observation.status === status && observation.path === path
})

export const authRoute = (route: AuthRouteKind): EvalMatcher => ({
  description: `auth-route:${route}`,
  matches: (observation) => observation.kind === "auth-route" && observation.route === route
})

export const authRouteObserved = (): EvalMatcher => ({
  description: "auth-route",
  matches: (observation) => observation.kind === "auth-route"
})

export const authFallback = (): EvalMatcher => ({
  description: "auth-fallback",
  matches: (observation) => observation.kind === "auth-fallback"
})

export const resourceOpened = (name: string): EvalMatcher => ({
  description: `resource-opened:${name}`,
  matches: (observation) => observation.kind === "resource" && observation.name === name && observation.state === "opened"
})

export const resourceClosed = (name: string): EvalMatcher => ({
  description: `resource-closed:${name}`,
  matches: (observation) => observation.kind === "resource" && observation.name === name && observation.state === "closed"
})

export const reportContains = (value: string): EvalMatcher => ({
  description: `report-contains:${value}`,
  matches: (observation) => observation.kind === "report-text" && observation.text.includes(value)
})

export const planTaskStatus = (
  stageId: string,
  taskId: string,
  status: PlanTaskStatusType
): EvalMatcher => ({
  description: `plan-task-status:${stageId}:${taskId}:${status}`,
  matches: (observation) =>
    observation.kind === "plan-task-status" &&
    observation.stageId === stageId &&
    observation.taskId === taskId &&
    observation.status === status
})

/** Any persisted status for the task — used to forbid writes for bogus ids. */
export const planTaskStatusObserved = (
  stageId: string,
  taskId: string
): EvalMatcher => ({
  description: `plan-task-status:${stageId}:${taskId}`,
  matches: (observation) =>
    observation.kind === "plan-task-status" &&
    observation.stageId === stageId &&
    observation.taskId === taskId
})

/** Any task reaching `status`, whatever the plan's ids — for replayed real sessions. */
export const anyPlanTaskStatus = (status: PlanTaskStatusType): EvalMatcher => ({
  description: `plan-task-status:*:*:${status}`,
  matches: (observation) =>
    observation.kind === "plan-task-status" && observation.status === status
})

export const planMarkerDropped = (reasonFragment?: string): EvalMatcher => ({
  description:
    reasonFragment === undefined
      ? "plan-marker-dropped"
      : `plan-marker-dropped:${reasonFragment}`,
  matches: (observation) =>
    observation.kind === "plan-marker-dropped" &&
    (reasonFragment === undefined || observation.reason.includes(reasonFragment))
})

export const before = (first: EvalMatcher, second: EvalMatcher): EvalOrdering => ({
  before: first,
  after: second
})
