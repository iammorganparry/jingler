import { useMemo } from "react"
import { cn } from "../lib/cn.js"
import { DiffView } from "./diff-view.js"
import { createPierreFileDiffFromPatch } from "./pierre-model.js"
import { patchFromStructuredLines } from "./parse.js"

export interface HunkLine {
  type: "add" | "del" | "normal"
  ln: number
  content: string
}

/** A compact, read-only single-file hunk rendered by Pierre. */
export function DiffHunk({
  path,
  status = "M",
  added,
  removed,
  lines,
  className
}: {
  path: string
  status?: "M" | "A" | "D"
  added: number
  removed: number
  lines: ReadonlyArray<HunkLine>
  className?: string
}) {
  const fileDiff = useMemo(
    () =>
      lines.length === 0
        ? null
        : createPierreFileDiffFromPatch(
            patchFromStructuredLines({
              path,
              status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
              lines: lines.map((line) => ({
                type: line.type,
                content: line.content,
                oldLn: line.type === "add" ? null : line.ln,
                newLn: line.type === "del" ? null : line.ln
              }))
            })
          ),
    [lines, path, status]
  )

  if (fileDiff === null) return null
  return (
    <DiffView
      fileDiff={fileDiff}
      label={`${path} diff, ${added} additions and ${removed} deletions`}
      fill={false}
      className={cn("overflow-hidden rounded-md border border-line", className)}
      options={{
        stickyHeader: false,
        hunkSeparators: "simple"
      }}
    />
  )
}
