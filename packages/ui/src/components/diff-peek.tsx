import { useMemo } from "react"
import { DiffView } from "../diff/diff-view.js"
import {
  normalizeDiffPreviewPatch,
  parsePierreFileDiffs
} from "../diff/parse.js"
import { cn } from "../lib/cn.js"

/** Compact read-only diff used by tool cards and Markdown `diff` fences. */
export function DiffPeek({ preview, className }: { preview: string; className?: string }) {
  const fileDiffs = useMemo(() => {
    const patch = normalizeDiffPreviewPatch(preview)
    return patch.length === 0 ? [] : parsePierreFileDiffs(patch)
  }, [preview])
  const multiFile = fileDiffs.length > 1

  return (
    <DiffView
      fileDiffs={fileDiffs}
      label="Diff preview"
      fill={multiFile}
      className={cn("bg-editor", multiFile && "h-[360px]", className)}
      options={{
        lineNumbers: false,
        wrap: true,
        stickyHeader: false,
        hunkSeparators: "simple"
      }}
    />
  )
}
