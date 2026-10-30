import type { SessionPrStatus } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { PrStatusGlyph } from "../composites/pr-glyph.js"
import { DiffStat } from "./diff-stat.js"

export interface RepoChipProps {
  /** Display repo name; an `owner/name` slug shows only `name`. */
  readonly repo: string
  /** This checkout's top PR, or null when it has none. */
  readonly prNumber?: number | null
  /** Live PR status for the checks dot; omitted while unpolled. */
  readonly pr?: SessionPrStatus | null
  readonly added?: number
  readonly removed?: number
  /** The repo folder is gone from disk: dashed red, no PR or diff. */
  readonly missing?: boolean
  readonly className?: string
}

/** One checkout of a workspace: repo, PR glyph + number, diff. One line by construction. */
export function RepoChip({ repo, prNumber = null, pr, added = 0, removed = 0, missing = false, className }: RepoChipProps) {
  const name = repo.split("/").filter(Boolean).at(-1) ?? repo
  return (
    <span
      data-testid={`repo-chip-${name}`}
      data-missing={missing || undefined}
      title={missing ? `${repo}: folder not found` : repo}
      className={cn(
        "inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[5px] border bg-panel px-1.5 py-[2px] font-mono text-[10.5px]",
        missing ? "border-dashed border-red text-red" : "border-line text-text-body",
        className
      )}
    >
      {!missing && prNumber !== null && <PrStatusGlyph pr={pr ?? { state: "open", checks: null }} size={10} />}
      <span>{!missing && prNumber !== null ? `${name} #${prNumber}` : name}</span>
      {!missing && <DiffStat added={added} removed={removed} className="text-[10.5px]" />}
    </span>
  )
}
