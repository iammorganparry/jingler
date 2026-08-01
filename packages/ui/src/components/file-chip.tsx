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
 * A dense file link with Material file identity and live worktree diff evidence.
 * It fills its container by default so long plan paths get one stable hit target.
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
      <FileIcon path={path} size={16} />
      <span className="min-w-0 flex-1 truncate text-left">
        {children ?? path}
      </span>
      {changed && (
        <DiffStat
          added={added}
          removed={removed}
          className="flex-none text-[10.5px]"
        />
      )}
    </>
  )
  const classes = cn(
    "flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg bg-surface px-3 font-mono text-[11px] text-text-bright shadow-[inset_0_0_0_1px_var(--sb-line)]",
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
        "outline-none transition-[background-color,box-shadow,scale] duration-150 ease-out hover:bg-line/40 hover:shadow-[inset_0_0_0_1px_var(--sb-line-strong)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]"
      )}
    >
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  )
}
