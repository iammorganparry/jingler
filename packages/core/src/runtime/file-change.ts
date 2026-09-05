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

/**
 * Ceiling on the preview text one change set may carry, in UTF-16 code units.
 *
 * A change set is persisted verbatim on its tool part, pushed to the renderer
 * on every stream event, and re-read on every transcript patch. Per-file
 * previews are already line-capped, but a command that deletes or rewrites a
 * directory produces hundreds of them: one `rm -rf .tmp` observed 307 changes
 * × ~22KB of preview = 1.4MB on a single part, eleven times in one turn, for a
 * 17MB assistant message. The full patch is on disk under `patchArtifactId`
 * regardless, so a preview is a convenience, and past this budget the
 * remaining files simply have none.
 */
export const FILE_CHANGE_PREVIEW_BUDGET = 256 * 1024

/**
 * Keep the first previews that fit inside `budget` and null out the rest.
 * Stable: order and every other field are untouched, and a set already within
 * budget is returned as-is.
 */
export const boundFileChangePreviews = <T extends { readonly preview: string | null }>(
  changes: ReadonlyArray<T>,
  budget: number = FILE_CHANGE_PREVIEW_BUDGET
): ReadonlyArray<T> => {
  let used = 0
  let trimmed = false
  const bounded = changes.map((change) => {
    if (change.preview === null) return change
    if (used + change.preview.length <= budget) {
      used += change.preview.length
      return change
    }
    trimmed = true
    return { ...change, preview: null }
  })
  return trimmed ? bounded : changes
}
