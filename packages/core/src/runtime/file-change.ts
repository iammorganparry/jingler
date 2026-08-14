import { Schema } from "effect"
import { DiffStat } from "../domain.js"

export const FileChangeStatus = Schema.Literal("A", "M", "D", "R")
export type FileChangeStatus = Schema.Schema.Type<typeof FileChangeStatus>

export const FileChange = Schema.Struct({
  status: FileChangeStatus,
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  added: Schema.Number,
  removed: Schema.Number,
  binary: Schema.Boolean,
  noNewlineAtEnd: Schema.Boolean,
  beforeBytes: Schema.NullOr(Schema.Number),
  afterBytes: Schema.NullOr(Schema.Number),
  preview: Schema.NullOr(Schema.String),
  patchArtifactId: Schema.NullOr(Schema.String)
})
export type FileChange = Schema.Schema.Type<typeof FileChange>

export const FileChangeArtifact = Schema.Struct({
  id: Schema.String,
  mediaType: Schema.Literal("text/x-diff"),
  byteLength: Schema.Number,
  sha256: Schema.String,
  truncated: Schema.Boolean,
  sessionId: Schema.String,
  createdAt: Schema.String
})
export type FileChangeArtifact = Schema.Schema.Type<typeof FileChangeArtifact>

export const FileChangeSet = Schema.Struct({
  id: Schema.String,
  callId: Schema.NullOr(Schema.String),
  changes: Schema.Array(FileChange),
  totals: DiffStat,
  authoritative: Schema.Boolean,
  reconciledAt: Schema.String
})
export type FileChangeSet = Schema.Schema.Type<typeof FileChangeSet>

export const fileChangeTotals = (changes: ReadonlyArray<FileChange>): Schema.Schema.Type<typeof DiffStat> =>
  changes.reduce(
    (totals, change) => ({ added: totals.added + change.added, removed: totals.removed + change.removed }),
    { added: 0, removed: 0 }
  )
