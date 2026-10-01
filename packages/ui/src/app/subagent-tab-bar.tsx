import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Bot, History } from "lucide-react"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import type { PreviousSubagentTabItem, SubagentTabItem } from "./chat-tab-bar.js"

export function SubagentTabBar({
  subagents,
  activeSubagentId,
  onSelectSubagent,
  previous = [],
  onOpenPrevious
}: {
  readonly subagents: ReadonlyArray<SubagentTabItem>
  readonly activeSubagentId?: string
  readonly onSelectSubagent: (id: string) => void
  /** Finished subagents of this chat, reopenable from the history menu. */
  readonly previous?: ReadonlyArray<PreviousSubagentTabItem>
  readonly onOpenPrevious?: (id: string) => void
}) {
  const history = onOpenPrevious ? previous : []
  if (subagents.length === 0 && history.length === 0) return null
  return (
    <div
      data-testid="subagent-tab-bar"
      className="sb-no-scrollbar flex h-8 min-w-0 flex-none items-center gap-1 overflow-x-auto border-b border-hairline bg-sunken/70 px-3"
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
      {history.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Previous subagents"
              title="Previous subagents"
              className="ml-auto flex flex-none items-center rounded-md px-1.5 py-1 text-dim outline-none hover:bg-panel hover:text-text"
            >
              <History className="size-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
            >
              {history.map((item) => (
                <DropdownMenu.Item
                  key={item.id}
                  aria-label={`Open ${item.title}`}
                  onSelect={() => onOpenPrevious?.(item.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                >
                  <Bot className="size-3.5 flex-none text-purple" />
                  <span className="truncate">{item.title}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  )
}
