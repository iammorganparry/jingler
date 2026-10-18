import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"
import { cn } from "../lib/cn.js"
import type { AgentFileRow } from "./review-agent-scope.js"

/**
 * "All agents" row list: one row per (tree, file). A file touched by two
 * trees gets two rows, each carrying a one-line agent chip so the owner stays
 * legible without widening the row onto a second line.
 */
export function AgentFileRows({
  rows,
  activeKey,
  onSelectRow
}: {
  readonly rows: readonly AgentFileRow[]
  readonly activeKey: string | null
  readonly onSelectRow: (row: AgentFileRow) => void
}) {
  return (
    <div role="listbox" aria-label="Changed files by agent" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          role="option"
          aria-selected={row.key === activeKey}
          onClick={() => onSelectRow(row)}
          className={cn(
            "flex h-7 w-full flex-none items-center gap-2 rounded-md px-2 text-left text-[12px] text-text-body hover:bg-hover",
            row.key === activeKey && "bg-surface text-text-bright"
          )}
        >
          <FileIcon path={row.file.path} size={13} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{row.file.path}</span>
          <span
            title={row.label}
            className="flex-none truncate whitespace-nowrap rounded-[5px] border border-line/70 bg-surface/40 px-1.5 py-[1px] text-[10px] text-dim"
          >
            {row.label}
          </span>
          <DiffStat added={row.file.additions} removed={row.file.deletions} className="flex-none" />
        </button>
      ))}
    </div>
  )
}
