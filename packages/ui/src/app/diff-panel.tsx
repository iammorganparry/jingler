import type { FileDiffMetadata } from "@pierre/diffs"
import { useMemo } from "react"
import { DiffView, type DiffActions } from "../diff/diff-view.js"
import type { DiffRow } from "../diff/parse.js"
import {
  parsePierreFileDiffs,
  patchFromDiffRows
} from "../diff/parse.js"

/**
 * Right-hand review rail: the virtualized worktree diff. The agent's edits are
 * already applied to the worktree, so this is a live view of what's on disk —
 * when `actions` is wired, lines can be selected to revert or to comment on
 * (routed to the session's agent).
 */
export function DiffPanel({
  rows,
  patch,
  fileDiffs,
  added,
  removed,
  actions
}: {
  rows?: ReadonlyArray<DiffRow>
  patch?: string
  fileDiffs?: readonly FileDiffMetadata[]
  added: number
  removed: number
  actions?: DiffActions
}) {
  const structured = useMemo(() => {
    if (fileDiffs !== undefined) return fileDiffs
    const source = rows === undefined ? (patch ?? "") : patchFromDiffRows(rows)
    return source.trim().length === 0 ? [] : parsePierreFileDiffs(source)
  }, [fileDiffs, patch, rows])

  return (
    <div className="flex w-[392px] flex-none flex-col border-l border-hairline bg-panel">
      <div className="flex h-[42px] flex-none items-center gap-2 border-b border-hairline px-[15px]">
        <span className="text-[12px] font-semibold text-text-bright">Changes</span>
        <span className="font-mono text-[10px] text-green">+{added}</span>
        <span className="font-mono text-[10px] text-red">−{removed}</span>
      </div>

      {/* Pierre CodeView virtualizes multi-file changesets. */}
      <div className="min-h-0 flex-1">
        <DiffView fileDiffs={structured} actions={actions} />
      </div>
    </div>
  )
}
