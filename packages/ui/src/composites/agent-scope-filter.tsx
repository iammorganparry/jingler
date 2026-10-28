import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { CHANGES_SCOPE_ALL, CHANGES_SCOPE_MAIN, type AgentTreeChanges } from "./review-agent-scope.js"

/** "All agents ▾": narrows Changes to one checkout — the main session, or one subagent's worktree. */
export function AgentScopeFilter({
  trees,
  value,
  onChange
}: {
  readonly trees: readonly AgentTreeChanges[]
  /** CHANGES_SCOPE_ALL, CHANGES_SCOPE_MAIN, or a subagent id. */
  readonly value: string
  readonly onChange: (scope: string) => void
}) {
  const agents = trees.filter((tree) => tree.agentId !== null)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-[30px] min-w-0 rounded-lg text-[12px]" aria-label="Filter by agent">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="right-auto w-[200px]">
        <SelectItem value={CHANGES_SCOPE_ALL} textValue="All agents">All agents</SelectItem>
        <SelectItem value={CHANGES_SCOPE_MAIN} textValue="Main">Main</SelectItem>
        {agents.map((tree) => (
          <SelectItem key={tree.agentId!} value={tree.agentId!} textValue={tree.label}>
            {tree.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
