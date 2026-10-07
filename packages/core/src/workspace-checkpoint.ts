import { Schema } from "effect"

export const WorkspaceCheckpoint = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.String,
  label: Schema.String,
  head: Schema.String,
  indexTree: Schema.String,
  worktreeTree: Schema.String,
  pinned: Schema.Boolean,
  restoreOutcome: Schema.optional(Schema.Literal("pending", "succeeded", "failed")),
  byteLength: Schema.Number
})
export type WorkspaceCheckpoint = typeof WorkspaceCheckpoint.Type

export const CheckpointFileOperation = Schema.Struct({
  path: Schema.String,
  action: Schema.Literal("create", "overwrite", "delete")
})
export const WorkspaceCheckpointPreview = Schema.Struct({
  checkpointId: Schema.String,
  token: Schema.String,
  operations: Schema.Array(CheckpointFileOperation),
  indexOperations: Schema.Array(CheckpointFileOperation),
  diff: Schema.String,
  indexDiff: Schema.String
})
export type WorkspaceCheckpointPreview = typeof WorkspaceCheckpointPreview.Type
