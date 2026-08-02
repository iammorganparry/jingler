import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { DiffStat } from "./diff-stat.js"
import { FileIcon } from "./file-icon.js"

export interface FileChipProps {
  readonly path: string
  readonly added?: number
  readonly removed?: number
  readonly onOpen?: (path: string) => void
  readonly className?: string
  /** Preserves an editor-owned content DOM while keeping the surrounding chip reusable. */
  readonly children?: ReactNode
}

/**
 * A thin, inline file link with Material file identity and diff evidence.
 *
 * It hugs its content (path + diff), left-aligned, so a run of them reads as a
 * row of chips rather than a stack of full-width buttons. The diff comes from
 * live worktree evidence while there is uncommitted work and from the plan's
 * recorded counts once that work is committed — so `+/−` stays visible either way.
 */
export function FileChip({
  path,
  added = 0,
  removed = 0,
  onOpen,
  className,
  children
}: FileChipProps) {
  const changed = added + removed > 0
  const label = `Open ${path}${changed ? ` (+${added} −${removed})` : ""}`
  const content = (
    <>
      <FileIcon path={path} size={13} />
      <span className="min-w-0 truncate">{children ?? path}</span>
      {changed && (
        <DiffStat
          added={added}
          removed={removed}
          className="ml-0.5 flex-none text-[10px]"
        />
      )}
    </>
  )
  const classes = cn(
    "inline-flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-[5px] border border-line/70 bg-surface/40 px-1.5 font-mono text-[10.5px] leading-none text-text-bright align-middle",
    className
  )

  return onOpen ? (
    <button
      type="button"
      aria-label={label}
      title={`${label} in asset viewer`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(path)}
      className={cn(
        classes,
        "outline-none transition-[background-color,border-color,scale] duration-150 ease-out hover:border-line-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
      )}
    >
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  )
}
