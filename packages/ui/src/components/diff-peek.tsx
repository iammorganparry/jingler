import { useMemo } from "react"
import { DiffView } from "../diff/diff-view.js"
import {
  normalizeDiffPreviewPatch,
  parsePierreFileDiffs
} from "../diff/parse.js"
import { cn } from "../lib/cn.js"

/**
 * A single-file peek above this many patch lines gets the virtualized,
 * fixed-height treatment multi-file peeks always had. Below it, the whole diff
 * fits on a screen and inline rows read better. Without the cap, `fill=false`
 * mounted EVERY line of every large edit's diff as an unvirtualized grid row —
 * heap snapshots of a leaking renderer showed ~92k live grid elements, mostly
 * these.
 */
const INLINE_PEEK_MAX_LINES = 200

/** Compact read-only diff used by tool cards and Markdown `diff` fences. */
export function DiffPeek({ preview, className }: { preview: string; className?: string }) {
  const { fileDiffs, large } = useMemo(() => {
    const patch = normalizeDiffPreviewPatch(preview)
    return {
      fileDiffs: patch.length === 0 ? [] : parsePierreFileDiffs(patch),
      large: countLines(patch) > INLINE_PEEK_MAX_LINES
    }
  }, [preview])
  const multiFile = fileDiffs.length > 1
  const bounded = multiFile || large

  return (
    <DiffView
      fileDiffs={fileDiffs}
      label="Diff preview"
      fill={bounded}
      className={cn("bg-editor", bounded && "h-[360px]", className)}
      options={{
        lineNumbers: false,
        wrap: true,
        stickyHeader: false,
        hunkSeparators: "simple",
        // A lone preview's synthetic "preview.diff" header names nothing the
        // surrounding card hasn't already said; headers earn their row only
        // when they distinguish multiple files.
        disableFileHeader: !multiFile
      }}
    />
  )
}

const countLines = (patch: string): number => {
  let lines = 1
  for (let i = patch.indexOf("\n"); i !== -1; i = patch.indexOf("\n", i + 1)) {
    lines++
  }
  return lines
}
