import { Bot } from "lucide-react"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import type { SubagentTabItem } from "./chat-tab-bar.js"

export function SubagentTabBar({
  subagents,
  activeSubagentId,
  onSelectSubagent
}: {
  readonly subagents: ReadonlyArray<SubagentTabItem>
  readonly activeSubagentId?: string
  readonly onSelectSubagent: (id: string) => void
}) {
  if (subagents.length === 0) return null
  return (
    <div
      data-testid="subagent-tab-bar"
      className="sb-no-scrollbar flex h-8 flex-none items-center gap-1 overflow-x-auto border-b border-hairline bg-sunken/70 px-3"
    >
      <span className="flex-none text-[10px] font-medium uppercase tracking-wide text-dim">Subagents</span>
      {subagents.map((subagent) => {
        const selected = subagent.id === activeSubagentId
        return (
          <button
            key={subagent.id}
            type="button"
            data-testid={`subagent-tab-${subagent.id}`}
            aria-current={selected ? "page" : undefined}
            aria-label={subagent.title}
            title={subagent.title}
            onClick={() => onSelectSubagent(subagent.id)}
            className={cn(
              "flex flex-none items-center gap-1.5 rounded-md px-2.5 py-1 text-xs outline-none transition-colors",
              selected ? "bg-panel text-text-bright" : "text-muted-foreground hover:bg-panel/60 hover:text-text"
            )}
          >
            <StatusDot tone={subagent.status === "attention" ? "bg-purple" : "bg-yellow"} pulse size={7} />
            <Bot className="size-3 text-purple" />
            <span className="max-w-[180px] truncate">{subagent.title}</span>
          </button>
        )
      })}
    </div>
  )
}
