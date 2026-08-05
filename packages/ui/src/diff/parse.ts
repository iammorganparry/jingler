import parseDiff from "parse-diff"
import type { File as DiffFile } from "parse-diff"
import type { FileDiffMetadata } from "@pierre/diffs"
import {
  canonicalPierrePath,
  createPierreCodeViewItemsFromPatch
} from "./pierre-model.js"

const LEADING_CURRENT_DIRECTORY = /^\.\//
const OLD_PATCH_HEADER = /^--- (?:a\/|\/dev\/null(?:\t|$))/m
const NEW_PATCH_HEADER = /^\+\+\+ (?:b\/|\/dev\/null(?:\t|$))/m
const TRAILING_NEWLINES = /\n+$/
const HUNK_SPEC = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * The diff engine flattens parsed files into a single list of rows so a
 * virtualizer can window over tens of thousands of lines cheaply — the same
 * approach GitHub / opencode's desktop diff viewer take.
 */
export type DiffRow =
  | {
      kind: "file"
      key: string
      path: string
      status: "modified" | "added" | "deleted" | "renamed"
      additions: number
      deletions: number
    }
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line"
      key: string
      type: "add" | "del" | "normal"
      oldLn: number | null
      newLn: number | null
      content: string
    }

function fileStatus(f: DiffFile): "modified" | "added" | "deleted" | "renamed" {
  if (f.new) return "added"
  if (f.deleted) return "deleted"
  if (f.from && f.to && f.from !== f.to) return "renamed"
  return "modified"
}

function filePath(f: DiffFile): string {
  return f.to && f.to !== "/dev/null" ? f.to : (f.from ?? "unknown")
}

/** Flatten already-parsed diff files into virtualizable rows. */
export function flattenFiles(files: ReadonlyArray<DiffFile>): DiffRow[] {
  const rows: DiffRow[] = []
  files.forEach((file, fi) => {
    const path = filePath(file)
    rows.push({
      kind: "file",
      key: `f${fi}`,
      path,
      status: fileStatus(file),
      additions: file.additions,
      deletions: file.deletions
    })
    file.chunks.forEach((chunk, ci) => {
      rows.push({ kind: "hunk", key: `f${fi}h${ci}`, header: chunk.content })
      chunk.changes.forEach((change, li) => {
        // parse-diff keeps the leading +/-/space marker on `content`.
        const content = change.content.length > 0 ? change.content.slice(1) : ""
        rows.push({
          kind: "line",
          key: `f${fi}h${ci}l${li}`,
          type: change.type,
          oldLn: change.type === "add" ? null : (change as { ln?: number; ln1?: number }).ln1 ?? (change as { ln?: number }).ln ?? null,
          newLn: change.type === "del" ? null : (change as { ln?: number; ln2?: number }).ln2 ?? (change as { ln?: number }).ln ?? null,
          content
        })
      })
    })
  })
  return rows
}

/** Parse a raw unified-diff/patch string into virtualizable rows. */
export function parseUnifiedDiff(patch: string): DiffRow[] {
  return flattenFiles(parseDiff(patch))
}

const comparablePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(LEADING_CURRENT_DIRECTORY, "")

/** Keep one file header and its hunks/lines from an already-flattened patch. */
export function diffRowsForPath(
  rows: ReadonlyArray<DiffRow>,
  path: string
): ReadonlyArray<DiffRow> {
  const wanted = comparablePath(path)
  const start = rows.findIndex(
    (row) => row.kind === "file" && comparablePath(row.path) === wanted
  )
  if (start < 0) return []
  const next = rows.findIndex((row, index) => index > start && row.kind === "file")
  return rows.slice(start, next < 0 ? undefined : next)
}

/** Parse a unified patch and return only the rows belonging to `path`. */
export function parseUnifiedDiffForPath(
  patch: string,
  path: string
): ReadonlyArray<DiffRow> {
  return diffRowsForPath(parseUnifiedDiff(patch), path)
}

/** A new Git file header terminates the current hunk body. */
const isFileBoundary = (lines: readonly string[], index: number): boolean =>
  lines[index]?.startsWith("diff --git ") === true ||
  (OLD_PATCH_HEADER.test(lines[index] ?? "") &&
    NEW_PATCH_HEADER.test(lines[index + 1] ?? ""))

const hunkLineContribution = (
  lines: string[],
  index: number
): readonly [old: number, next: number] => {
  const line = lines[index] ?? ""
  if (line.startsWith("\\") || (line.length === 0 && index === lines.length - 1)) {
    return [0, 0]
  }
  if (line.startsWith("+")) return [0, 1]
  if (line.startsWith("-")) return [1, 0]
  // Hand-authored fixtures often omit Git's single-space marker on blank context.
  if (line.length === 0) lines[index] = " "
  return [1, 1]
}

const countHunkLines = (
  lines: string[],
  start: number
): readonly [old: number, next: number] => {
  let oldCount = 0
  let newCount = 0
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (HUNK_SPEC.test(line) || isFileBoundary(lines, index)) break
    const [oldLine, newLine] = hunkLineContribution(lines, index)
    oldCount += oldLine
    newCount += newLine
  }
  return [oldCount, newCount]
}

/** Repair counts in hand-authored patches; real Git patches pass through unchanged. */
export const normalizePatchHunkCounts = (patch: string): string => {
  const lines = patch.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const match = HUNK_SPEC.exec(lines[index] ?? "")
    if (match === null) continue
    const [oldCount, newCount] = countHunkLines(lines, index + 1)
    lines[index] = `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`
  }
  return lines.join("\n")
}

/**
 * The legacy row parser remains for plan evidence and the Code Review migration,
 * but rendering consumers use Pierre's structured file metadata from here on.
 */
export const parsePierreFileDiffs = (patch: string): FileDiffMetadata[] =>
  createPierreCodeViewItemsFromPatch(normalizePatchHunkCounts(patch)).flatMap((item) =>
    item.type === "diff" ? [item.fileDiff] : []
  )

/** Resolve one canonical repo path from a multi-file patch. */
export const parsePierreFileDiffForPath = (
  patch: string,
  path: string
): FileDiffMetadata | null => {
  const wanted = canonicalPierrePath(path)
  return (
    parsePierreFileDiffs(patch).find(
      (fileDiff) =>
        canonicalPierrePath(fileDiff.name) === wanted ||
        (fileDiff.prevName !== undefined &&
          canonicalPierrePath(fileDiff.prevName) === wanted)
    ) ?? null
  )
}

export interface StructuredDiffLine {
  readonly type: "add" | "del" | "normal"
  readonly content: string
  readonly oldLn?: number | null
  readonly newLn?: number | null
}

const hunkStart = (
  lines: readonly StructuredDiffLine[],
  side: "old" | "new",
  fallback: number
): number => {
  const line = lines.find((candidate) =>
    side === "old" ? candidate.oldLn != null : candidate.newLn != null
  )
  return side === "old"
    ? (line?.oldLn ?? fallback)
    : (line?.newLn ?? fallback)
}

type StructuredPatchStatus = "modified" | "added" | "deleted"

const structuredHunk = (
  lines: readonly StructuredDiffLine[],
  startLine = 1
): string[] => {
  const oldCount = lines.filter((line) => line.type !== "add").length
  const newCount = lines.filter((line) => line.type !== "del").length
  const oldStart = oldCount === 0 ? 0 : hunkStart(lines, "old", startLine)
  const newStart = newCount === 0 ? 0 : hunkStart(lines, "new", startLine)
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...lines.map((line) => {
      const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " "
      return `${marker}${line.content}`
    })
  ]
}

const structuredPatch = ({
  path: inputPath,
  status,
  hunks,
  startLine = 1
}: {
  readonly path: string
  readonly status: StructuredPatchStatus
  readonly hunks: readonly (readonly StructuredDiffLine[])[]
  readonly startLine?: number
}): string => {
  const path = canonicalPierrePath(inputPath)
  const oldPath = status === "added" ? "/dev/null" : `a/${path}`
  const newPath = status === "deleted" ? "/dev/null" : `b/${path}`
  const metadata = status === "added"
    ? ["new file mode 100644"]
    : status === "deleted"
      ? ["deleted file mode 100644"]
      : []
  return [
    `diff --git a/${path} b/${path}`,
    ...metadata,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...hunks.flatMap((hunk, index) => structuredHunk(hunk, index === 0 ? startLine : 1))
  ].join("\n")
}

/** Build a valid single-file Git patch from compact, already-classified lines. */
export const patchFromStructuredLines = ({
  path,
  status = "modified",
  lines,
  startLine = 1
}: {
  readonly path: string
  readonly status?: StructuredPatchStatus
  readonly lines: readonly StructuredDiffLine[]
  readonly startLine?: number
}): string => structuredPatch({ path, status, hunks: [lines], startLine })

const patchStatusFromRow = (
  file: Extract<DiffRow, { kind: "file" }>
): StructuredPatchStatus => {
  if (file.status === "added") return "added"
  if (file.status === "deleted") return "deleted"
  return "modified"
}

/** Keep the old rows API readable while Pierre owns their rendering. */
export const patchFromDiffRows = (rows: ReadonlyArray<DiffRow>): string => {
  const patches: string[] = []
  let file: Extract<DiffRow, { kind: "file" }> | null = null
  let hunks: StructuredDiffLine[][] = []
  let lines: StructuredDiffLine[] = []

  const flush = () => {
    if (lines.length > 0) hunks.push(lines)
    if (file !== null && hunks.length > 0) {
      patches.push(structuredPatch({
        path: file.path,
        status: patchStatusFromRow(file),
        hunks
      }))
    }
    hunks = []
    lines = []
  }

  for (const row of rows) {
    if (row.kind === "file") {
      flush()
      file = row
      continue
    }
    if (row.kind === "hunk") {
      if (lines.length > 0) hunks.push(lines)
      lines = []
      continue
    }
    lines.push({
      type: row.type,
      content: row.content,
      oldLn: row.oldLn,
      newLn: row.newLn
    })
  }
  flush()
  return patches.join("\n")
}

const hasPatchHeaders = (preview: string): boolean =>
  preview.startsWith("diff --git ") ||
  (OLD_PATCH_HEADER.test(preview) && NEW_PATCH_HEADER.test(preview))

/**
 * Tool and Markdown previews are sometimes full patches, sometimes bare hunks,
 * and sometimes only +/- lines. Normalize every form before handing it to
 * Pierre rather than teaching a second renderer how to interpret markers.
 */
export const normalizeDiffPreviewPatch = (
  preview: string,
  path = "preview.diff"
): string => {
  const trimmed = preview.replace(TRAILING_NEWLINES, "")
  if (trimmed.length === 0) return ""
  if (hasPatchHeaders(trimmed)) return trimmed
  if (trimmed.startsWith("@@ ")) {
    const canonicalPath = canonicalPierrePath(path)
    return [
      `diff --git a/${canonicalPath} b/${canonicalPath}`,
      `--- a/${canonicalPath}`,
      `+++ b/${canonicalPath}`,
      trimmed
    ].join("\n")
  }

  const lines: StructuredDiffLine[] = trimmed.split("\n").map((raw) => {
    const marker = raw[0]
    if (marker === "+") return { type: "add", content: raw.slice(1) }
    if (marker === "-") return { type: "del", content: raw.slice(1) }
    if (marker === " ") return { type: "normal", content: raw.slice(1) }
    return { type: "normal", content: raw }
  })
  return patchFromStructuredLines({ path, lines })
}
