import { X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { FileIcon } from "./file-icon.js"

/**
 * A rendered code reference. Bare `@file` mentions keep the compact basename;
 * captured source ranges show their full repository path and inclusive lines.
 * Optional `onRemove` shows a dismiss affordance.
 */
export function CodeChip({
  path,
  line,
  label,
  onRemove,
  className
}: {
  path: string
  line?: number
  /** Canonical renderer-owned display label for a captured range. */
  label?: string
  onRemove?: () => void
  className?: string
}) {
  const name = path.split("/").pop() ?? path
  const isCapturedRange = label !== undefined
  const displayLabel = label ?? name
  return (
    <span
      title={isCapturedRange ? displayLabel : path}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-bright",
        className
      )}
    >
      <FileIcon path={path} size={12} />
      {displayLabel}
      {!isCapturedRange && line !== undefined && <span className="text-dim">:{line}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${displayLabel}`}
          className="text-dim hover:text-text"
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}
