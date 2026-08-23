import * as ContextMenu from "@radix-ui/react-context-menu"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Fragment, useState, type ReactNode } from "react"
import { Bot, ChevronRight, FileStack, History, MessagesSquare, Plus, RotateCcw, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier, type WidthTier } from "../hooks/width-tier.js"
import { StatusDot } from "../components/status-dot.js"

export interface ChatTabItem {
  id: string
  title: string
  running?: boolean
}

export interface SubagentTabItem {
  id: string
  title: string
  status: "running" | "attention"
}

export interface PreviousSubagentTabItem {
  id: string
  title: string
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
  subagents?: ReadonlyArray<SubagentTabItem>
  subagentChatId?: string
  activeSubagentId?: string
  onSelectSubagent?: (id: string) => void
  previousSubagents?: ReadonlyArray<PreviousSubagentTabItem>
  onOpenPreviousSubagent?: (id: string) => void
  /** Session-owned tabs rendered beside chats, before the new-chat action. */
  fileSlot?: ReactNode
  /** Whether the file group owns the currently visible session surface. */
  filesActive?: boolean
  /** Close every open chat (the group label's right-click menu). */
  onCloseAllChats?: () => void
  /** Close every open file tab (the group label's right-click menu). */
  onCloseAllFiles?: () => void
}

/**
 * Right-click menu for a tab-group label. Rendered only when the group has a
 * bulk action to offer — a context menu with nothing in it is a dead end.
 */
function GroupContextMenu({
  label,
  onSelect,
  children
}: {
  label: string
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          collisionPadding={8}
          className="z-50 flex min-w-[180px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          <ContextMenu.Item
            aria-label={label}
            onSelect={onSelect}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
          >
            <X className="size-3.5 flex-none text-dim" />
            {label}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

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
  onReopenChat,
  subagents = [],
  subagentChatId,
  activeSubagentId,
  onSelectSubagent,
  previousSubagents = [],
  onOpenPreviousSubagent,
  fileSlot,
  filesActive = false,
  onCloseAllChats,
  onCloseAllFiles
}: ChatTabBarProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const tier = useWidthTier()
  const width = CHAT_WIDTH[tier]
  const fileCount = Array.isArray(fileSlot) ? fileSlot.length : fileSlot == null ? 0 : 1
  const commit = (id: string) => {
    if (draft.trim()) onRenameChat(id, draft.trim())
    setEditing(null)
  }

  const chatsGroupLabel = (
    <button
      type="button"
      aria-label={`${chatsExpanded ? "Collapse" : "Expand"} chats group`}
      aria-expanded={chatsExpanded}
      title={`${chats.length} open ${chats.length === 1 ? "chat" : "chats"}`}
      onClick={() => setChatsExpanded((expanded) => !expanded)}
      className={cn(
        "flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors hover:bg-panel hover:text-text-bright",
        !filesActive ? "bg-panel text-text-bright" : "text-muted-foreground"
      )}
    >
      <ChevronRight className={cn("size-3 transition-transform", chatsExpanded && "rotate-90")} />
      <MessagesSquare className="size-3 text-blue" />
      <span>Chats</span>
      <span className="text-dim">{chats.length}</span>
    </button>
  )

  return (
    <>
      {onCloseAllChats ? (
        <GroupContextMenu label="Close all chats" onSelect={onCloseAllChats}>
          {chatsGroupLabel}
        </GroupContextMenu>
      ) : (
        chatsGroupLabel
      )}
      {chatsExpanded && chats.map((chat, index) => {
        const active = chat.id === activeChatId
        // The active chat keeps its name at every width. Losing it would leave a
        // row of identical dots and no answer to "which one am I typing into".
        const showTitle = width !== null || active || editing === chat.id
        return (
          <Fragment key={chat.id}>
          <div
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
          {chat.id === subagentChatId && subagents.map((subagent) => {
            const selected = subagent.id === activeSubagentId
            return (
              <button
                key={subagent.id}
                type="button"
                data-testid={`subagent-tab-${subagent.id}`}
                aria-current={selected ? "page" : undefined}
                aria-label={subagent.title}
                title={subagent.title}
                onClick={() => onSelectSubagent?.(subagent.id)}
                className={cn(
                  "flex flex-none items-center gap-1.5 rounded-md px-2.5 py-1 text-xs outline-none transition-colors",
                  selected ? "bg-panel text-text-bright" : "text-muted-foreground hover:bg-panel/60 hover:text-text"
                )}
              >
                <StatusDot
                  tone={subagent.status === "attention" ? "bg-purple" : "bg-yellow"}
                  pulse
                  size={7}
                />
                <Bot className="size-3 text-purple" />
                <span className="max-w-[140px] truncate">{subagent.title}</span>
              </button>
            )
          })}
          </Fragment>
        )
      })}
      {chatsExpanded && <button
        type="button"
        aria-label="New chat"
        title="New chat (⌘T)"
        onClick={onCreateChat}
        className="flex flex-none items-center rounded-md px-1.5 py-1.5 text-dim outline-none transition-colors hover:bg-panel hover:text-text"
      >
        <Plus className="size-3.5" />
      </button>}
      {chatsExpanded && (
        (closedChats.length > 0 && onReopenChat !== undefined) ||
        (previousSubagents.length > 0 && onOpenPreviousSubagent !== undefined)
      ) && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Previous chats"
              title="Previous chats"
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
                  onSelect={() => onReopenChat?.(chat.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                >
                  <RotateCcw className="size-3.5 flex-none text-dim" />
                  <span className="truncate">{chat.title}</span>
                </DropdownMenu.Item>
              ))}
              {previousSubagents.map((subagent) => (
                <DropdownMenu.Item
                  key={subagent.id}
                  aria-label={`Open ${subagent.title}`}
                  onSelect={() => onOpenPreviousSubagent?.(subagent.id)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                >
                  <Bot className="size-3.5 flex-none text-purple" />
                  <span className="truncate">{subagent.title}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {fileCount > 0 && (() => {
        const filesGroupLabel = (
          <button
            type="button"
            aria-label={`${filesExpanded ? "Collapse" : "Expand"} files group`}
            aria-expanded={filesExpanded}
            title={`${fileCount} open ${fileCount === 1 ? "file" : "files"}`}
            onClick={() => setFilesExpanded((expanded) => !expanded)}
            className={cn(
              "flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors hover:bg-panel hover:text-text-bright",
              filesActive ? "bg-panel text-text-bright" : "text-muted-foreground"
            )}
          >
            <ChevronRight className={cn("size-3 transition-transform", filesExpanded && "rotate-90")} />
            <FileStack className="size-3 text-purple" />
            <span>Files</span>
            <span className="text-dim">{fileCount}</span>
          </button>
        )
        return onCloseAllFiles ? (
          <GroupContextMenu label="Close all files" onSelect={onCloseAllFiles}>
            {filesGroupLabel}
          </GroupContextMenu>
        ) : (
          filesGroupLabel
        )
      })()}
      {filesExpanded ? fileSlot : null}
    </>
  )
}
