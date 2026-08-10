import type { DiffStat } from "@jingler/core"
import { unifiedDiffStats } from "./runtime/file-changes/unified-diff.js"

/**
 * Codex supplies a unified diff for each entry in a fileChange item's `changes`
 * array. Keep this input deliberately structural: the SDK and app-server use
 * different event types, and older Codex builds may omit the field entirely.
 */
interface CodexFileChange {
  readonly diff?: unknown
}

const diffOf = (change: unknown): string | null => {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return null
  const diff = (change as CodexFileChange).diff
  return typeof diff === "string" && diff.length > 0 ? diff : null
}

/**
 * Convert Codex file-change diffs to Jingler's edit-card representation.
 *
 * Only lines inside unified-diff hunks are included. File headers and hunk
 * coordinates would otherwise be mis-coloured by DiffPeek and inflate the
 * added/removed totals. A missing or unrecognisable diff retains the historical
 * null fallback for compatibility with older Codex versions.
 */
export const codexFileChangeStats = (
  changes: ReadonlyArray<unknown>
): { readonly diff: DiffStat | null; readonly preview: string | null } => {
  const previewLines: Array<string> = []
  let added = 0
  let removed = 0

  for (const change of changes) {
    const unified = diffOf(change)
    if (unified === null) continue
    const stats = unifiedDiffStats(unified)
    added += stats.added
    removed += stats.removed
    if (stats.preview !== null) {
      if (previewLines.length > 0) previewLines.push(" ")
      previewLines.push(...stats.preview.split("\n"))
    }
  }

  if (previewLines.length === 0) return { diff: null, preview: null }

  const hidden = Math.max(0, previewLines.length - 120)
  const shown = previewLines.slice(0, 120)
  if (hidden > 0) shown.push(`…${hidden} more diff line(s)`)
  return { diff: { added, removed }, preview: shown.join("\n") }
}
