import type { DiffStat } from "@jingler/core"

/**
 * Codex supplies a unified diff for each entry in a fileChange item's `changes`
 * array. Keep this input deliberately structural: the SDK and app-server use
 * different event types, and older Codex builds may omit the field entirely.
 */
interface CodexFileChange {
  readonly diff?: unknown
}

/** Keep persisted transcript cards compact even when Codex applies a large patch. */
const MAX_PREVIEW_LINES = 120

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
  let sawHunkLine = false

  for (const change of changes) {
    const unified = diffOf(change)
    if (unified === null) continue

    const fileLines: Array<string> = []
    let inHunk = false
    for (const line of unified.split("\n")) {
      if (line.startsWith("@@")) {
        inHunk = true
        continue
      }
      if (line.startsWith("diff --git ")) {
        inHunk = false
        continue
      }
      if (!inHunk || line === "\\ No newline at end of file") continue

      const marker = line[0]
      if (marker === "+") added++
      else if (marker === "-") removed++
      else if (marker !== " ") continue

      sawHunkLine = true
      fileLines.push(line)
    }

    if (fileLines.length > 0) {
      if (previewLines.length > 0) previewLines.push(" ")
      previewLines.push(...fileLines)
    }
  }

  if (!sawHunkLine) return { diff: null, preview: null }

  const hidden = Math.max(0, previewLines.length - MAX_PREVIEW_LINES)
  const shown = previewLines.slice(0, MAX_PREVIEW_LINES)
  if (hidden > 0) shown.push(`…${hidden} more diff line(s)`)
  return { diff: { added, removed }, preview: shown.join("\n") }
}
