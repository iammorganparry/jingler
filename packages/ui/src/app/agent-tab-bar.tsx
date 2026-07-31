import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useState } from "react"
import { ChevronRight, History, MessagesSquare, Plus, RotateCcw, X } from "lucide-react"
import type { SubagentStatus, WorkerLifecycleStatus } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier, type WidthTier } from "../hooks/width-tier.js"
import { StatusDot } from "../components/status-dot.js"

/** The "Main" tab id — the parent conversation, always the first crumb. */
export const MAIN_AGENT = "main"

/** Every lifecycle rendered in the shared agent rail. */
export type VisibleAgentStatus = SubagentStatus | WorkerLifecycleStatus

/** One visible-agent cell's data, sans transcript. */
export interface AgentTabItem {
  id: string
  /** Agent label, e.g. "Explore", "Reviewer", or "worker-auth". */
  name: string
  /** Task/route description — shown as the cell's tooltip. */
  description: string
  status: VisibleAgentStatus
  /** This Claude agent spawned children — offer a drill-in affordance. */
  hasChildren: boolean
  /**
   * The source-authoritative action for this tab.
   *
   * Claude sub-agents stop while working and close once settled. A running
   * orchestration worker can stop, but replay-backed workers never close.
   * Reviewers and queued workers expose no action.
   */
  action?: "stop" | "close"
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
  closedChats?: ReadonlyArray<ChatTabItem>
  activeChatId: string
  onSelectChat: (id: string) => void
  onCreateChat: () => void
  onRenameChat: (id: string, title: string) => void
  onCloseChat: (id: string) => void
  onReopenChat?: (id: string) => void
}

export interface AgentTabBarProps {
  agents: ReadonlyArray<AgentTabItem>
  trail: ReadonlyArray<AgentCrumb>
  active: string
  onChange: (key: string) => void
  onDrill: (id: string) => void
  onNavigate: (id: string) => void
  /** Stop the live agent identified by a tab whose action is `stop`. */
  onStop: (id: string) => void
  /** Dismiss a settled Claude sub-agent whose action is `close`. */
  onClose: (id: string) => void
}

/** Backwards-compatible name for consumers still referring to the old rail. */
export type SubagentTabBarProps = AgentTabBarProps

/**
 * Status → dot tone + pulse (working pulses like a live run).
 *
 * `stopped` is dim rather than red on purpose: the operator killed it, so it is
 * settled business, not something to go and read. Red is reserved for the agent
 * that failed on its own and wants attention.
 */
const DOT: Record<VisibleAgentStatus, { tone: string; pulse: boolean }> = {
  working: { tone: "bg-yellow", pulse: true },
  done: { tone: "bg-green", pulse: false },
  error: { tone: "bg-red", pulse: false },
  stopped: { tone: "bg-dim", pulse: false },
  queued: { tone: "bg-dim", pulse: false },
  running: { tone: "bg-yellow", pulse: true },
  blocked: { tone: "bg-yellow", pulse: false },
  failed: { tone: "bg-red", pulse: false },
  interrupted: { tone: "bg-dim", pulse: false },
  completed: { tone: "bg-green", pulse: false }
}

/**
 * The sub-agent rail, nested directly beneath the main `TabBar`. It surfaces the
 * harness's live sub-agents (`Task` spawns) as watch-only pills.
 *
 * It reads as a level deeper than the main bar by sitting ON the editor surface
 * rather than the darker strip — it used to also carry a bottom accent and a
 * hairline per cell, which mattered when it was one of three ruled rows and now
 * just re-adds the noise the redesign removed. Active is a raised pill, same as
 * every other tab in the pane.
 *
 * Sub-agents nest arbitrarily, which a flat strip can't express, so the rail shows
 * ONE level at a time: a breadcrumb of the drill path, then a pill per agent at
 * that level. An agent that spawned its own sub-agents gets a `>` affordance to
 * drill into them. This keeps the rail a fixed height at any depth.
 *
 * This is the row that made the old stack unbearable: it only appears mid-turn,
 * so the pane GAINED a ruled row exactly when you were reading fastest. It now
 * arrives as a few chips on the same surface.
 *
 * Presentational only — the pane owns the drill level, derives each level's cells,
 * and owns which cell is active.
 */
export function AgentTabBar({
  agents,
  trail,
  active,
  onChange,
  onDrill,
  onNavigate,
  onStop,
  onClose
}: AgentTabBarProps) {
  const tier = useWidthTier()
  // The task description is the first thing to go. It's the longest string in the
  // rail by far and it's already the hover title on the pill it belongs to.
  const showDescription = atLeast(tier, "wide")
  return (
    <div className="sb-no-scrollbar flex h-8 flex-none items-center gap-0.5 overflow-x-auto border-b border-hairline bg-editor px-2">
      <button
        type="button"
        onClick={() => onNavigate(MAIN_AGENT)}
        aria-current={active === MAIN_AGENT ? "page" : undefined}
        className={cn(
          "group flex flex-none items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] outline-none transition-colors",
          active === MAIN_AGENT
            ? "bg-panel text-text-bright"
            : "text-muted-foreground hover:bg-panel/60 hover:text-text"
        )}
      >
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
            "flex flex-none items-center gap-1 rounded-md py-0.5 pl-0.5 pr-2 text-[11.5px] outline-none transition-colors",
            active === crumb.id
              ? "bg-panel text-text-bright"
              : "text-muted-foreground hover:bg-panel/60 hover:text-text"
          )}
        >
          <ChevronRight className="size-3 flex-none text-dim" />
          <span className="whitespace-nowrap font-medium">{crumb.name}</span>
        </button>
      ))}

      {agents.map((agent) => {
        const isActive = agent.id === active
        const dot = DOT[agent.status]
        const actionLabel =
          agent.action === undefined
            ? null
            : `${agent.action === "stop" ? "Stop" : "Close"} ${agent.name}`
        return (
          <div
            key={agent.id}
            data-agent-status={agent.status}
            className={cn(
              "group flex flex-none items-center rounded-md transition-colors",
              isActive
                ? "bg-panel text-text-bright"
                : "text-muted-foreground hover:bg-panel/60 hover:text-text"
            )}
          >
            <button
              type="button"
              onClick={() => onChange(agent.id)}
              title={agent.description || agent.name}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 py-0.5 pl-2 text-[11.5px] outline-none",
                // `pr-2` only when nothing follows. A pill with a `>` or a ×
                // after it would otherwise carry the gap twice.
                agent.hasChildren || agent.action !== undefined ? "pr-1" : "pr-2"
              )}
            >
              <StatusDot tone={dot.tone} pulse={dot.pulse} size={7} />
              <span className="whitespace-nowrap font-medium">{agent.name}</span>
              <span className="sr-only">{agent.status}</span>
              {agent.description && showDescription && (
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
                className="flex items-center pr-1.5 text-dim outline-none transition-colors hover:text-text"
              >
                <ChevronRight className="size-3 flex-none" />
              </button>
            )}
            {actionLabel !== null && (
              <button
                type="button"
                aria-label={actionLabel}
                title={actionLabel}
                onClick={() =>
                  agent.action === "stop"
                    ? onStop(agent.id)
                    : onClose(agent.id)
                }
                className="mr-1 rounded p-0.5 text-dim opacity-0 outline-none hover:bg-editor hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** @deprecated Use `AgentTabBar`; retained while downstream plugins migrate. */
export const SubagentTabBar = AgentTabBar

/** How wide a chat pill's title may grow, per tier. `null` = show it on hover only. */
const CHAT_WIDTH: Record<WidthTier, string | null> = {
  wide: "max-w-[190px]",
  mid: "max-w-[130px]",
  narrow: "max-w-[96px]",
  tiny: null
}

/**
 * The chat pills — a *fragment*, not a row.
 *
 * This used to be its own full-width strip with its own bottom border, stacked
 * under the main tab bar; it now renders INSIDE `TabBar`'s scroller, behind a
 * divider (see `chatSlot` there). That's the whole point of the redesign: the
 * pane went from three ruled rows before any transcript to one, and the two
 * things this row and that one carry — which view, which conversation — turned
 * out to sit fine side by side once neither was a box.
 *
 * Being a fragment means it inherits the parent scroller's `gap` and alignment,
 * so every child must be `flex-none`. It also means the ONE horizontal scroll is
 * shared: chat pills and view tabs scroll together rather than independently,
 * which is what makes a narrow pane feel like one row instead of two half-rows.
 *
 * At `tiny` the inactive pills drop their titles and become dots. Nothing is
 * hidden behind a menu at any width — a chat you can't see is a chat you forget
 * is running.
 */
export function ChatTabBar({
  chats,
  closedChats = [],
  activeChatId,
  onSelectChat,
  onCreateChat,
  onRenameChat,
  onCloseChat,
  onReopenChat
}: ChatTabBarProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const tier = useWidthTier()
  const width = CHAT_WIDTH[tier]
  const commit = (id: string) => {
    if (draft.trim()) onRenameChat(id, draft.trim())
    setEditing(null)
  }

  return (
    <>
      {chats.map((chat, index) => {
        const active = chat.id === activeChatId
        // The active chat keeps its name at every width. Losing it would leave a
        // row of identical dots and no answer to "which one am I typing into".
        const showTitle = width !== null || active || editing === chat.id
        return (
          <div
            key={chat.id}
            data-testid={`chat-tab-${chat.id}`}
            className={cn(
              "group flex flex-none items-center rounded-md transition-colors",
              active ? "bg-panel text-text-bright" : "text-muted-foreground hover:bg-panel/60"
            )}
          >
            <button
              type="button"
              data-testid={active ? "active-chat-tab" : undefined}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectChat(chat.id)}
              onDoubleClick={() => {
                setDraft(chat.title)
                setEditing(chat.id)
              }}
              // The name has to survive the title being dropped at `tiny` — this
              // is what a screen reader and `getByRole` read once the text is gone.
              aria-label={chat.title}
              className={cn(
                "flex min-w-0 items-center gap-2 py-1 text-left text-xs outline-none",
                // Room for the close × only while the pill is showing words; a
                // dot-only pill would be mostly padding.
                showTitle ? "pl-2.5 pr-1" : "px-2"
              )}
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
                showTitle && (
                  <span className={cn("truncate", width ?? "max-w-[140px]")}>{chat.title}</span>
                )
              )}
            </button>
            {showTitle && (
              <button
                type="button"
                aria-label={`Close ${chat.title}`}
                title={`Close ${chat.title}`}
                onClick={() => onCloseChat(chat.id)}
                className="mr-1 rounded p-0.5 text-dim opacity-0 outline-none hover:bg-editor hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        aria-label="New chat"
        title="New chat (⌘T)"
        onClick={onCreateChat}
        className="flex flex-none items-center rounded-md px-1.5 py-1.5 text-dim outline-none transition-colors hover:bg-panel hover:text-text"
      >
        <Plus className="size-3.5" />
      </button>
      {closedChats.length > 0 && onReopenChat !== undefined && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Closed chats"
              title="Closed chats"
              className="flex flex-none items-center rounded-md px-1.5 py-1.5 text-dim outline-none transition-colors hover:bg-panel hover:text-text"
            >
              <History className="size-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 flex min-w-[200px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
            >
              {closedChats.map((chat) => (
                <DropdownMenu.Item
                  key={chat.id}
                  aria-label={`Reopen ${chat.title}`}
                  onSelect={() => onReopenChat(chat.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                >
                  <RotateCcw className="size-3.5 flex-none text-dim" />
                  <span className="truncate">{chat.title}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </>
  )
}
