import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { createContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { SubagentFleetStatus } from "@jingler/core"
import { ArrowLeft, ChevronDown, Eye, Plus, X } from "lucide-react"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import { fmtElapsed } from "../lib/relative-time.js"
import { LIVE_STATUSES, fleetStatusDot, useNow } from "./subagent-meta-strip.js"

export interface ChatLaneHeaderChat {
  readonly id: string
  readonly title: string
  readonly running?: boolean
}

/** A subagent's transcript is swapped into this lane; the header shows where we are. */
export interface ChatLaneHeaderSubagentView {
  readonly selectedId: string
  /** Every subagent of this chat, including the selected one. */
  readonly siblings: ReadonlyArray<{
    readonly id: string
    readonly agent: string
    readonly task: string
    readonly status?: SubagentFleetStatus
    readonly startedAt?: number
    readonly completedAt?: number | null
  }>
  readonly onSwitch: (id: string) => void
  /** Back to the main transcript. */
  readonly onBack: () => void
}

/** Window event that opens the focused lane's thread switcher (e.g. a toast's "View"). */
export const OPEN_THREAD_SWITCHER_EVENT = "jingler:open-thread-switcher"

/** Host-provided lookup so lane headers deep in the editor tree can show the breadcrumb. */
export const SubagentLaneViewContext = createContext<(chatId: string) => ChatLaneHeaderSubagentView | null>(
  () => null
)

export interface ChatLaneHeaderProps {
  /** Open chats in this session. */
  readonly chats: ReadonlyArray<ChatLaneHeaderChat>
  /** Currently active chat ID. */
  readonly activeChatId: string
  /** Switch to a different chat thread. */
  readonly onSelectChat: (id: string) => void
  /** Create a new chat thread. */
  /** Omit when the host offers New chat elsewhere (the editor group's + menu). */
  readonly onCreateChat?: () => void
  /** Close a chat tab. Omit to hide the per-chat close items. */
  readonly onCloseChat?: (id: string) => void
  /** Whether the file browser follows this chat's agent edits. */
  readonly followAgent?: boolean
  /** Toggle the shared agent-follow mode. */
  readonly onToggleFollowAgent?: (enabled: boolean) => void
  /** Rendered in the subagent slot, e.g. a `SubagentChip`. */
  readonly subagentSlot?: ReactNode
  /** When set, the header shows `← Main`, then a status dot and `<agent> ▾` switcher; Esc also goes back. */
  readonly subagentView?: ChatLaneHeaderSubagentView | null
}

/** The shared agent-follow toggle: in the lane header, or in its subagent slot via the host. */
export function FollowAgentToggle({
  followAgent,
  onToggleFollowAgent
}: {
  readonly followAgent: boolean
  readonly onToggleFollowAgent: (enabled: boolean) => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="follow-agent-toggle"
      aria-label="Follow agent"
      aria-pressed={followAgent}
      title={
        followAgent
          ? "Stop following files edited by this chat's agent"
          : "Follow files edited by this chat's agent"
      }
      onClick={() => onToggleFollowAgent(!followAgent)}
      className={cn("flex-none gap-1.5 px-1.5", followAgent && "bg-surface text-text-bright")}
    >
      <Eye className="size-3.5" />
      <span className="hidden @[420px]:inline">Follow agent</span>
    </Button>
  )
}

function SubagentBreadcrumb({ view }: { readonly view: ChatLaneHeaderSubagentView }) {
  const current = view.siblings.find((sibling) => sibling.id === view.selectedId)
  const live = current?.status !== undefined && LIVE_STATUSES.has(current.status)
  const now = useNow(live)
  const elapsed = (sibling: ChatLaneHeaderSubagentView["siblings"][number]) =>
    sibling.startedAt === undefined ? null : fmtElapsed((sibling.completedAt ?? now) - sibling.startedAt)
  return (
    <div data-testid="subagent-breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-xs">
      {/* Board 20a: bordered "← Main" pill with an Esc hint, first in the row. */}
      <Button variant="outline" size="sm" data-testid="subagent-back" onClick={view.onBack} className="flex-none gap-1.5 px-2">
        <ArrowLeft className="size-3" /> Main <Kbd>Esc</Kbd>
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid="subagent-crumb"
            aria-label="Switch subagent"
            className="min-w-0 justify-start gap-1.5 px-2 text-xs"
          >
            {current?.status && <StatusDot {...fleetStatusDot(current.status)} size={7} />}
            <span className="min-w-0 truncate font-medium text-text-bright">{current?.agent ?? "Subagent"}</span>
            <ChevronDown className="size-3 flex-none text-dim" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex min-w-[220px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
          >
            {view.siblings.map((sibling) => (
              <DropdownMenu.Item
                key={sibling.id}
                data-testid={`subagent-crumb-option-${sibling.id}`}
                title={sibling.task}
                aria-label={`${sibling.agent} · ${sibling.task}`}
                onSelect={() => view.onSwitch(sibling.id)}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
              >
                {sibling.status && <StatusDot {...fleetStatusDot(sibling.status)} size={7} />}
                <span className={cn("min-w-0 flex-1 truncate", sibling.id === view.selectedId ? "text-text-bright" : "text-text-body")}>
                  {sibling.agent}
                </span>
                <span className="flex-none tabular-nums text-dim">{elapsed(sibling)}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {current && elapsed(current) && (
        <span data-testid="subagent-elapsed" className="flex-none tabular-nums text-dim">{elapsed(current)}</span>
      )}
      <span className="flex-1" />
    </div>
  )
}

/**
 * Chat lane header: thread switcher dropdown, new chat, subagent chip slot,
 * and follow-agent toggle.
 *
 * Replaces the chat tab strip in redesign 4.3. The header sits above the
 * transcript, consolidating thread selection into a dropdown rather than
 * horizontal pills. The subagent slot hosts the SubagentChip (#460).
 */
export function ChatLaneHeader({
  chats,
  activeChatId,
  onSelectChat,
  onCreateChat,
  onCloseChat,
  followAgent = false,
  onToggleFollowAgent,
  subagentSlot,
  subagentView
}: ChatLaneHeaderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const onBack = subagentView?.onBack
  // Esc returns to main unless something (composer menu, open dropdown) already consumed it,
  // and only for the focused editor group so sibling lanes are left alone.
  useEffect(() => {
    if (!onBack) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const group = rootRef.current?.closest('[data-testid="editor-group"]')
      if (group && !group.hasAttribute("data-focused")) return
      onBack()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onBack])

  const [switcherOpen, setSwitcherOpen] = useState(false)
  useEffect(() => {
    const onOpen = () => {
      const group = rootRef.current?.closest('[data-testid="editor-group"]')
      if (group && !group.hasAttribute("data-focused")) return
      setSwitcherOpen(true)
    }
    window.addEventListener(OPEN_THREAD_SWITCHER_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_THREAD_SWITCHER_EVENT, onOpen)
  }, [])

  const activeChat = chats.find((chat) => chat.id === activeChatId)
  const activeTitle = activeChat?.title ?? "Chat"

  return (
    <div
      ref={rootRef}
      data-testid="chat-lane-header"
      className="flex h-10 min-w-0 flex-1 items-center gap-2 @container border-b border-hairline bg-sunken/70 px-3"
    >
      {subagentView ? <SubagentBreadcrumb view={subagentView} /> : (
      <DropdownMenu.Root open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid="thread-switcher"
            aria-label="Switch chat thread"
            className="min-w-0 max-w-[60%] justify-start gap-2 bg-surface px-2.5 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-left font-medium text-text-bright">
              {activeTitle}
            </span>
            {activeChat?.running && (
              <StatusDot tone="bg-muted-foreground" pulse size={7} />
            )}
            <ChevronDown className="size-3 flex-none text-dim" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex min-w-[220px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
          >
            {chats.map((chat) => {
              const active = chat.id === activeChatId
              return (
                <div key={chat.id} className="flex items-center gap-0.5">
                  <DropdownMenu.Item
                    data-testid={`chat-option-${chat.id}`}
                    onSelect={() => onSelectChat(chat.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                  >
                    <StatusDot
                      tone={chat.running ? "bg-muted-foreground" : active ? "bg-text-bright" : "bg-dim"}
                      pulse={chat.running ?? false}
                      size={7}
                    />
                    <span className={cn("min-w-0 flex-1 truncate", active ? "text-text-bright" : "text-text-body")}>
                      {chat.title}
                    </span>
                  </DropdownMenu.Item>
                  {onCloseChat && (
                    <DropdownMenu.Item
                      data-testid={`chat-close-${chat.id}`}
                      aria-label={`Close ${chat.title}`}
                      onSelect={() => onCloseChat(chat.id)}
                      className="flex flex-none cursor-pointer items-center rounded-md p-2 text-dim outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                    >
                      <X className="size-3" />
                    </DropdownMenu.Item>
                  )}
                </div>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      )}

      {onCreateChat && !subagentView && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="new-chat-button"
          aria-label="New chat"
          title="New chat"
          onClick={onCreateChat}
          className="flex-none gap-1.5 px-1.5"
        >
          <Plus className="size-3.5" />
          <span className="hidden @[420px]:inline">New chat</span>
        </Button>
      )}

      {!subagentView && <div data-testid="subagent-slot" className="flex-none">{subagentSlot}</div>}
      <span className="flex-1" />

      {onToggleFollowAgent && !subagentView && (
        <FollowAgentToggle followAgent={followAgent} onToggleFollowAgent={onToggleFollowAgent} />
      )}
    </div>
  )
}
