import { useState } from "react"
import { ChevronRight, MessagesSquare, Plus, X } from "lucide-react"
import type { SubagentStatus } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

/** The "Main" tab id — the parent conversation, always the first crumb. */
export const MAIN_AGENT = "main"

/** One sub-agent cell's data (a projection of `Subagent`, sans transcript). */
export interface AgentTabItem {
  id: string
  /** Sub-agent type, e.g. "Explore" / "general-purpose". */
  name: string
  /** The task description — shown as the cell's tooltip. */
  description: string
  status: SubagentStatus
  /** This agent spawned sub-agents of its own — offer a drill-in affordance. */
  hasChildren: boolean
}

/** One crumb in the drill path — `MAIN_AGENT`, then each drilled-into agent. */
export interface AgentCrumb {
  id: string
  name: string
}

export interface ChatTabItem {
  id: string
  title: string
  running?: boolean
}

export interface ChatTabBarProps {
  chats: ReadonlyArray<ChatTabItem>
  activeChatId: string
  onSelectChat: (id: string) => void
  onCreateChat: () => void
  onRenameChat: (id: string, title: string) => void
  onCloseChat: (id: string) => void
}

export interface SubagentTabBarProps {
  agents: ReadonlyArray<AgentTabItem>
  trail: ReadonlyArray<AgentCrumb>
  active: string
  onChange: (key: string) => void
  onDrill: (id: string) => void
  onNavigate: (id: string) => void
}

/** Status → dot tone + pulse (working pulses like a live run). */
const DOT: Record<SubagentStatus, { tone: string; pulse: boolean }> = {
  working: { tone: "bg-yellow", pulse: true },
  done: { tone: "bg-green", pulse: false },
  error: { tone: "bg-red", pulse: false }
}

/**
 * The secondary tab bar, nested directly beneath the main `TabBar`. It surfaces
 * the harness's live sub-agents (`Task` spawns) as watch-only tabs. It reads as a
 * level deeper than the main bar — it sits ON the editor surface (not the darker
 * strip) with a bottom accent on the active cell (the main bar uses a top accent).
 *
 * Sub-agents nest arbitrarily, which a flat strip can't express, so the bar shows
 * ONE level at a time: a breadcrumb of the drill path, then a cell per agent at
 * that level. An agent that spawned its own sub-agents gets a `>` affordance to
 * drill into them. This keeps the strip a fixed height at any depth.
 *
 * Presentational only — the pane owns the drill level, derives each level's cells,
 * and owns which cell is active.
 */
export function SubagentTabBar({
  agents,
  trail,
  active,
  onChange,
  onDrill,
  onNavigate
}: SubagentTabBarProps) {
  return (
    <div className="flex h-8 flex-none items-stretch overflow-x-auto border-b border-hairline bg-editor">
      <button
        type="button"
        onClick={() => onNavigate(MAIN_AGENT)}
        aria-current={active === MAIN_AGENT ? "page" : undefined}
        className={cn(
          "group relative flex flex-none items-center gap-1.5 border-r border-hairline px-3 text-[11.5px] outline-none transition-colors",
          active === MAIN_AGENT ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
        )}
      >
        {active === MAIN_AGENT && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
        <MessagesSquare
          className={cn("size-3 flex-none", active === MAIN_AGENT ? "text-blue" : "text-dim")}
        />
        <span className="whitespace-nowrap">Main</span>
      </button>

      {/* The drill path. Each crumb jumps the level back to that agent's children. */}
      {trail.map((crumb) => (
        <button
          key={crumb.id}
          type="button"
          onClick={() => onNavigate(crumb.id)}
          title={`Back to ${crumb.name}'s sub-agents`}
          className={cn(
            "relative flex flex-none items-center gap-1 border-r border-hairline pl-1.5 pr-2.5 text-[11.5px] outline-none transition-colors",
            active === crumb.id
              ? "text-text"
              : "text-muted-foreground hover:bg-panel hover:text-text"
          )}
        >
          {active === crumb.id && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
          <ChevronRight className="size-3 flex-none text-dim" />
          <span className="whitespace-nowrap font-medium">{crumb.name}</span>
        </button>
      ))}

      {agents.map((agent) => {
        const isActive = agent.id === active
        const dot = DOT[agent.status]
        return (
          <div
            key={agent.id}
            className={cn(
              "group relative flex flex-none items-stretch border-r border-hairline transition-colors",
              isActive ? "text-text" : "text-muted-foreground hover:bg-panel hover:text-text"
            )}
          >
            {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue" />}
            <button
              type="button"
              onClick={() => onChange(agent.id)}
              title={agent.description || agent.name}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 pl-3 text-[11.5px] outline-none",
                agent.hasChildren ? "pr-1.5" : "pr-3"
              )}
            >
              <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} />
              <span className="whitespace-nowrap font-medium">{agent.name}</span>
              {agent.description && (
                <span className="max-w-[180px] truncate text-dim group-hover:text-muted-foreground">
                  {agent.description}
                </span>
              )}
            </button>
            {agent.hasChildren && (
              <button
                type="button"
                onClick={() => onDrill(agent.id)}
                title={`Show ${agent.name}'s sub-agents`}
                aria-label={`Show ${agent.name}'s sub-agents`}
                className="flex items-center pr-2 text-dim outline-none transition-colors hover:text-text"
              >
                <ChevronRight className="size-3 flex-none" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ChatTabBar({
  chats,
  activeChatId,
  onSelectChat,
  onCreateChat,
  onRenameChat,
  onCloseChat
}: ChatTabBarProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const commit = (id: string) => {
    if (draft.trim()) onRenameChat(id, draft.trim())
    setEditing(null)
  }

  return (
    <div className="flex h-9 flex-none items-stretch overflow-x-auto border-b border-hairline bg-editor">
      {chats.map((chat, index) => {
        const active = chat.id === activeChatId
        return (
          <div
            key={chat.id}
            className={cn(
              "group relative flex min-w-[120px] max-w-[220px] flex-none items-center border-r border-hairline",
              active ? "bg-panel text-text" : "text-muted-foreground hover:bg-panel/60"
            )}
          >
            {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-blue" />}
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectChat(chat.id)}
              onDoubleClick={() => {
                setDraft(chat.title)
                setEditing(chat.id)
              }}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs outline-none"
              title={`${index + 1}. ${chat.title}`}
            >
              <StatusDot
                tone={chat.running ? "bg-yellow" : active ? "bg-blue" : "bg-dim"}
                pulse={chat.running ?? false}
                size={7}
              />
              {editing === chat.id ? (
                <input
                  value={draft}
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commit(chat.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commit(chat.id)
                    if (event.key === "Escape") setEditing(null)
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  aria-label="Chat title"
                />
              ) : (
                <span className="truncate">{chat.title}</span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${chat.title}`}
              title={`Close ${chat.title}`}
              onClick={() => onCloseChat(chat.id)}
              className="mr-1 rounded p-1 text-dim opacity-0 outline-none hover:bg-editor hover:text-text group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        aria-label="New chat"
        title="New chat (⌘T)"
        onClick={onCreateChat}
        className="flex flex-none items-center px-3 text-dim outline-none hover:bg-panel hover:text-text"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
