import { useMemo } from "react"
import { cn } from "../lib/cn.js"
import { DiffView } from "./diff-view.js"
import { parseDiffHunkToPierre } from "./parse-diff-hunk.js"

/** GitHub's immutable thread excerpt, rendered read-only by Pierre. */
export function ReviewThreadHunk({ hunk, className }: { hunk: string; className?: string }) {
  const fileDiff = useMemo(() => parseDiffHunkToPierre(hunk), [hunk])
  if (fileDiff === null) return null

  return (
    <DiffView
      fileDiff={fileDiff}
      label="Review thread diff context"
      fill={false}
      className={cn("overflow-x-auto bg-editor", className)}
      options={{
        stickyHeader: false,
        hunkSeparators: "simple"
      }}
    />
  )
}
