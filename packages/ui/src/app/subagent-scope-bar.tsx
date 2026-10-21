import { Button } from "../components/button.js"

export interface SubagentScopeBarProps {
  readonly agent: string
  readonly branch: string | null
  readonly prNumber: number | null
  /** Widen content back to all agents without leaving the child view. */
  readonly onShowAll: () => void
}

/** One-line bar atop the content area while it is scoped to the viewed subagent. */
export function SubagentScopeBar({ agent, branch, prNumber, onShowAll }: SubagentScopeBarProps) {
  const parts = [`Scoped to ${agent}`, branch, prNumber === null ? null : `PR #${prNumber}`]
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
