import { Button } from "../components/button.js"

export interface SubagentScopeBarProps {
  readonly agent: string
  readonly branch: string | null
  readonly prNumber: number | null
  /** "removed": the child's worktree is gone; "empty": it has no changes yet. */
  readonly state?: "active" | "empty" | "removed"
  readonly baseRef?: string | null
  /** Widen content back to all agents without leaving the child view. */
  readonly onShowAll: () => void
}

/** One-line bar atop the content area while it is scoped to the viewed subagent. */
export function SubagentScopeBar({ agent, branch, prNumber, state = "active", baseRef = null, onShowAll }: SubagentScopeBarProps) {
  const parts = [`Scoped to ${agent}`, branch, prNumber === null ? null : `PR #${prNumber}`]
  const note =
    state === "removed" ? (baseRef ? `Worktree removed (changes may be merged into ${baseRef})` : "Worktree removed") : state === "empty" ? "No changes yet" : null
  if (note) parts.push(note)
  return (
    <div
      data-testid="subagent-scope-bar"
      className="flex h-8 flex-none items-center gap-2 border-b border-hairline bg-sunken px-3 text-[11px] text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{parts.filter(Boolean).join(" · ")}</span>
      <Button variant="ghost" size="sm" className="h-6 flex-none px-2 text-[11px]" onClick={onShowAll}>
        Show all agents
      </Button>
    </div>
  )
}
