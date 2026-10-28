import type { ArchiveReason } from "@jingler/core"
import { GitMerge, RotateCcw, Trash2, XCircle } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"

export interface ArchivedBannerProps {
  reason: ArchiveReason
  prNumber: number | null
  /** The base branch the PR targeted (for "merged into main"). */
  base?: string | null
  onRestore?: () => void
  onDelete?: () => void
}

/**
 * The archived-session banner (design A1) shown atop a read-only session whose PR
 * was merged or closed. A neutral one-line BannerShell with the two exits the user
 * has: restore it to keep iterating, or delete it for good.
 */
export function ArchivedBanner({ reason, prNumber, base, onRestore, onDelete }: ArchivedBannerProps) {
  const merged = reason === "merged"
  const restore = onRestore && (
    <Button key="restore" variant="secondary" size="sm" aria-label="Restore session" onClick={onRestore}>
      <RotateCcw size={13} />
      Restore
    </Button>
  )
  const del = onDelete && (
    <Button key="delete" variant="danger" size="sm" onClick={onDelete}>
      <Trash2 size={13} />
      Delete
    </Button>
  )
  const actions = restore && del ? ([restore, del] as const) : restore || del ? ([restore || del] as const) : undefined
  const pr = prNumber === null ? "" : ` #${prNumber}`
  const target = base ? ` ${merged ? "into" : "on"} ${base}` : ""
  return (
    <BannerShell
      placement="top"
      className="flex-none px-[30px]"
      icon={merged ? <GitMerge size={14} /> : <XCircle size={14} />}
      actions={actions}
    >
      {`Pull request${pr} was ${merged ? "merged" : "closed"}${target}. This session is archived and now read-only…`}
    </BannerShell>
  )
}
