import type { FileChange } from "@jingler/core"
import { ArrowRight, ChevronRight } from "lucide-react"
import { useState } from "react"
import { useOpenPath } from "../asset/open-asset-context.js"
import { cn } from "../lib/cn.js"
import { DiffPeek } from "./diff-peek.js"
import { DiffStat } from "./diff-stat.js"
import { FileIcon } from "./file-icon.js"

/**
 * Above this many changed files, per-file diffs render on demand instead of
 * eagerly. Every `DiffPeek` is a full Pierre diff instance (parse + provider
 * + highlighted rows), and tool calls that touch whole trees are real: one
 * benchmarked `pnpm patch-commit` card carried 226 files / 79k deleted lines,
 * and a second card re-adding them sat beside it — mounting ~450 diff
 * renderers in one commit was a multi-GB renderer spike. The rows themselves
 * (path, status, ±stat) stay: they are the information; the diff is detail.
 */
const EAGER_PREVIEW_MAX = 8

const STATUS = {
  A: { label: "Created", tone: "border-green/30 bg-green/10 text-green" },
  M: { label: "Modified", tone: "border-yellow/30 bg-yellow/10 text-yellow" },
  D: { label: "Deleted", tone: "border-red/30 bg-red/10 text-red" },
  R: { label: "Renamed", tone: "border-blue/30 bg-blue/10 text-blue" }
} as const

function ChangePath({ change }: { readonly change: FileChange }) {
  const open = useOpenPath(change.path)
  const path = (
    <>
      {change.oldPath !== null && (
        <>
          <span className="truncate text-dim">{change.oldPath}</span>
          <ArrowRight className="size-3 shrink-0 text-dim" aria-hidden />
        </>
      )}
      <span className="truncate text-text-bright">{change.path}</span>
    </>
  )

  return open === null ? (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">{path}</span>
  ) : (
    <button
      type="button"
      title={`Open ${change.path}`}
      onClick={open}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {path}
    </button>
  )
}

function FileChangeRow({
  change,
  eagerPreview
}: {
  readonly change: FileChange
  /** Mount the diff with the row; false defers it behind a per-row toggle. */
  readonly eagerPreview: boolean
}) {
  const status = STATUS[change.status]
  const [previewRequested, setPreviewRequested] = useState(false)
  const showPreview = change.preview !== null && (eagerPreview || previewRequested)
  return (
    <div data-file-change={change.status} data-file-path={change.path}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11px]">
        <span
          className={cn(
            "inline-flex w-[58px] shrink-0 justify-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            status.tone
          )}
        >
          {status.label}
        </span>
        <FileIcon path={change.path} />
        <ChangePath change={change} />
        {change.binary ? (
          <span className="shrink-0 text-dim">Binary</span>
        ) : (
          <DiffStat added={change.added} removed={change.removed} className="shrink-0" />
        )}
        {change.noNewlineAtEnd && (
          <span className="shrink-0 text-dim" title="No newline at end of file">No newline</span>
        )}
        {change.preview !== null && !eagerPreview && (
          <button
            type="button"
            data-testid="show-file-diff"
            onClick={() => setPreviewRequested((v) => !v)}
            className="flex shrink-0 items-center gap-0.5 text-dim outline-none transition-colors hover:text-muted-foreground"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", previewRequested && "rotate-90")}
            />
            Diff
          </button>
        )}
      </div>
      {showPreview && change.preview !== null && <DiffPeek preview={change.preview} />}
    </div>
  )
}

/** Canonical post-execution create/modify/delete/rename evidence for a tool call. */
export function FileChangeList({ changes }: { readonly changes: ReadonlyArray<FileChange> }) {
  // A single change with a preview is already fully described by the tool
  // card's own header (path, status, diff stat) — repeating it as a row would
  // stack three title bars over one diff. Multi-file changes keep their rows:
  // there the per-file identity is the information.
  const only = changes.length === 1 ? changes[0]! : null
  if (only !== null && only.preview !== null) {
    return (
      <div
        className="border-t border-line/60 bg-editor"
        data-file-change={only.status}
        data-file-path={only.path}
      >
        <DiffPeek preview={only.preview} />
      </div>
    )
  }
  const eagerPreview = changes.length <= EAGER_PREVIEW_MAX
  return (
    <div className="divide-y divide-line/60 border-t border-line/60 bg-editor">
      {changes.map((change) => (
        <FileChangeRow
          key={`${change.status}:${change.oldPath ?? ""}:${change.path}`}
          change={change}
          eagerPreview={eagerPreview}
        />
      ))}
    </div>
  )
}
