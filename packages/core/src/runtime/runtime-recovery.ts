import { Schema } from "effect"

/** Durable, renderer-safe evidence for a mutation whose outcome is unknown. */
export const UncertainMutationRecovery = Schema.Struct({
  runId: Schema.String,
  callId: Schema.String,
  chatId: Schema.String,
  toolId: Schema.String,
  targetCategory: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  fileChangeSetIds: Schema.Array(Schema.String)
})
export type UncertainMutationRecovery = Schema.Schema.Type<
  typeof UncertainMutationRecovery
>

/** Session-scoped restart recovery state. Arguments and source patches are excluded. */
export const RuntimeRecoveryState = Schema.Struct({
  uncertainMutations: Schema.Array(UncertainMutationRecovery)
})
export type RuntimeRecoveryState = Schema.Schema.Type<typeof RuntimeRecoveryState>

export class RuntimeRecoveryError extends Schema.TaggedError<RuntimeRecoveryError>()(
  "RuntimeRecoveryError",
  { message: Schema.String }
) {}
