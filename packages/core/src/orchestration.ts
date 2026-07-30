import { Schema } from "effect"
import { CliKind } from "./cli.js"
import { StreamEvent } from "./conversation.js"

/**
 * Provider-neutral worker lifecycle shared by orchestration, RPC, and renderer
 * projections. These values deliberately match the orchestration worker
 * machine; stage-only states such as `skipped` do not belong here.
 */
export const WorkerLifecycleStatus = Schema.Literal(
  "queued",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "completed"
)
export type WorkerLifecycleStatus = Schema.Schema.Type<typeof WorkerLifecycleStatus>

const IdentityString = Schema.String.pipe(Schema.minLength(1))

/**
 * Stable identity and route for one logical plan worker attempt.
 *
 * `agentId` survives retries while `attempt` distinguishes their event streams.
 * Carrying the plan and producing chat makes each activity self-routing even
 * when several plans or chats are observed in the same renderer process.
 */
export const WorkerIdentity = Schema.Struct({
  sessionId: IdentityString,
  planId: IdentityString,
  producingChatId: IdentityString,
  agentId: IdentityString,
  stageIds: Schema.Array(IdentityString),
  harness: CliKind,
  model: IdentityString,
  attempt: Schema.Int.pipe(Schema.nonNegative())
})
export type WorkerIdentity = Schema.Schema.Type<typeof WorkerIdentity>

const WorkerStateFields = {
  worker: WorkerIdentity,
  status: WorkerLifecycleStatus,
  message: Schema.NullOr(Schema.String)
}

/** The latest lifecycle projection for one worker. */
export const WorkerState = Schema.Struct(WorkerStateFields)
export type WorkerState = Schema.Schema.Type<typeof WorkerState>

/**
 * Reset the listed workers' lifecycle projections and transcripts.
 *
 * A new plan lists all of its workers; a targeted retry lists only the selected
 * worker so settled siblings remain untouched. The plan scope is carried
 * independently of `workers` so even an empty reset is unambiguous.
 */
export const WorkerActivityReset = Schema.TaggedStruct("Reset", {
  sessionId: IdentityString,
  planId: IdentityString,
  producingChatId: IdentityString,
  workers: Schema.Array(WorkerState)
})
export type WorkerActivityReset = Schema.Schema.Type<typeof WorkerActivityReset>

/** Replace one worker's lifecycle projection. */
export const WorkerActivityState = Schema.TaggedStruct("State", WorkerStateFields)
export type WorkerActivityState = Schema.Schema.Type<typeof WorkerActivityState>

/**
 * One normalized harness event emitted while a worker executes an assigned
 * stage. `stageId` disambiguates workers that own more than one stage.
 */
export const WorkerActivityHarnessEvent = Schema.TaggedStruct("HarnessEvent", {
  worker: WorkerIdentity,
  stageId: IdentityString,
  event: StreamEvent
})
export type WorkerActivityHarnessEvent = Schema.Schema.Type<
  typeof WorkerActivityHarnessEvent
>

/**
 * Read-only activity vocabulary for observing orchestration without coupling
 * the renderer to a concrete harness or causing execution as a side effect.
 */
export const WorkerActivity = Schema.Union(
  WorkerActivityReset,
  WorkerActivityState,
  WorkerActivityHarnessEvent
)
export type WorkerActivity = Schema.Schema.Type<typeof WorkerActivity>
