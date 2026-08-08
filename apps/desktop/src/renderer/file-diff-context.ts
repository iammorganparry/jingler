import type { JinglerLineSelection } from "@jingler/ui"
import { parseUnifiedDiffForPath } from "@jingler/ui"
import { normalizeCodeReference, type CodeReference } from "./code-reference.js"

type ChangeRow = Extract<
  ReturnType<typeof parseUnifiedDiffForPath>[number],
  { readonly kind: "line" }
>

const changedPreviewLines = (
  preview: string | null,
  marker: "+" | "-"
): readonly string[] =>
  preview === null
    ? []
    : preview
        .split("\n")
        .filter((line) => line.startsWith(marker))
        .map((line) => line.slice(1))

const containsSequence = (values: readonly string[], wanted: readonly string[]): boolean => {
  if (wanted.length === 0) return true
  for (let start = 0; start <= values.length - wanted.length; start += 1) {
    if (wanted.every((line, index) => values[start + index] === line)) return true
  }
  return false
}

const changeGroups = (rows: ReturnType<typeof parseUnifiedDiffForPath>): ChangeRow[][] => {
  const groups: ChangeRow[][] = []
  let current: ChangeRow[] = []
  for (const row of rows) {
    if (row.kind === "line" && row.type !== "normal") {
      current.push(row)
      continue
    }
    if (current.length > 0) groups.push(current)
    current = []
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Locate the mutation tool's compact preview inside the full worktree patch. */
export const agentFollowDiffSelection = (
  patch: string,
  path: string,
  preview: string | null
): JinglerLineSelection | null => {
  const groups = changeGroups(parseUnifiedDiffForPath(patch, path))
  const additions = changedPreviewLines(preview, "+")
  const deletions = changedPreviewLines(preview, "-")
  const group =
    groups.find(
      (candidate) =>
        containsSequence(
          candidate.filter((row) => row.type === "add").map((row) => row.content),
          additions
        ) &&
        containsSequence(
          candidate.filter((row) => row.type === "del").map((row) => row.content),
          deletions
        )
    ) ?? groups[0]
  if (group === undefined) return null

  const added = group.filter((row) => row.type === "add" && row.newLn !== null)
  const deleted = group.filter((row) => row.type === "del" && row.oldLn !== null)
  const focused = added.length > 0 ? added : deleted
  const side = added.length > 0 ? ("new" as const) : ("old" as const)
  const lineNumbers = focused.flatMap((row) => {
    const line = side === "new" ? row.newLn : row.oldLn
    return line === null ? [] : [line]
  })
  if (lineNumbers.length === 0) return null
  return {
    path,
    side,
    startLine: Math.min(...lineNumbers),
    endLine: Math.max(...lineNumbers),
    endSide: side
  }
}

/** Capture either side of a partial patch without requiring the whole old file. */
export const captureDiffCodeReference = (
  patch: string,
  selection: JinglerLineSelection
): CodeReference | null => {
  if (selection.side !== selection.endSide) return null
  const side = selection.side
  const startLine = Math.min(selection.startLine, selection.endLine)
  const endLine = Math.max(selection.startLine, selection.endLine)
  const rows = parseUnifiedDiffForPath(patch, selection.path).filter(
    (row): row is ChangeRow => row.kind === "line"
  )
  const lines: string[] = []
  for (let line = startLine; line <= endLine; line += 1) {
    const row = rows.find((candidate) => {
      if (side === "new") return candidate.type !== "del" && candidate.newLn === line
      return candidate.type !== "add" && candidate.oldLn === line
    })
    if (row === undefined) return null
    lines.push(`${row.content}\n`)
  }
  return normalizeCodeReference({
    path: selection.path,
    startLine,
    endLine,
    source: lines.join("")
  })
}
