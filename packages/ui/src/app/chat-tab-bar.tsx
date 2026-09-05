import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react"
import { Bot, ChevronRight, FileStack, History, Layers3, MessagesSquare, Plus, RotateCcw, type LucideIcon, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier, type WidthTier } from "../hooks/width-tier.js"
import { ContextMenu } from "../components/context-menu.js"
import { StatusDot } from "../components/status-dot.js"
import { CommandPalette } from "./command-palette.js"
import type { PaletteItem } from "./command-palette-model.js"
import { SESSION_SURFACE_DND_MIME } from "./session-surface-layout.js"

export interface ChatTabItem {
  id: string
  title: string
  running?: boolean
  surfaceKey?: string
}

export interface TabLauncherItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly detail?: string
  readonly onSelect: () => void
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
  /** Open auxiliary view tabs rendered after files. */
  viewSlot?: ReactNode
  viewCount?: number
  viewsActive?: boolean
  onCloseAllViews?: () => void
  /** One model drives the anchored + dropdown and the ⌘T command menu. */
  launcherItems?: ReadonlyArray<TabLauncherItem>
  /** Only the focused outer session pane handles the global ⌘T chord. */
  paneFocused?: boolean
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
    <ContextMenu items={[{ label, icon: X, onSelect }]}>
      {children}
    </ContextMenu>
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
  previousSubagents = [],
  onOpenPreviousSubagent,
  fileSlot,
  filesActive = false,
  onCloseAllChats,
  onCloseAllFiles,
  viewSlot,
  viewCount = 0,
  viewsActive = false,
  onCloseAllViews,
  launcherItems,
  paneFocused = true
}: ChatTabBarProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [viewsExpanded, setViewsExpanded] = useState(true)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const tier = useWidthTier()
  const width = CHAT_WIDTH[tier]
  const fileCount = Array.isArray(fileSlot) ? fileSlot.length : fileSlot == null ? 0 : 1
  const launchers = launcherItems ?? []
  const commandItems = useMemo<ReadonlyArray<PaletteItem>>(
    () =>
      launchers.map((item, index) => ({
        id: `new-tab:${item.id}`,
        kind: "tab" as const,
        group: "New tab",
        label: item.label,
        detail: item.detail,
        icon: item.icon,
        hint: index < 9 ? String(index + 1) : undefined,
        run: item.onSelect
      })),
    [launchers]
  )

  useEffect(() => {
    if (!paneFocused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.code === "KeyT" || event.key.toLowerCase() === "t")
      ) {
        event.preventDefault()
        setLauncherOpen(false)
        setCommandOpen(true)
        return
      }
      if ((!launcherOpen && !commandOpen) || event.metaKey || event.ctrlKey || event.altKey) return
      const index = Number(event.key) - 1
      const item = index >= 0 && index < Math.min(launchers.length, 9) ? launchers[index] : undefined
      if (!item) return
      event.preventDefault()
      setLauncherOpen(false)
      setCommandOpen(false)
      item.onSelect()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [commandOpen, launcherOpen, launchers, paneFocused])

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
        !filesActive && !viewsActive ? "bg-panel text-text-bright" : "text-muted-foreground"
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
            draggable={chat.surfaceKey !== undefined}
            onDragStart={(event) => {
              if (!chat.surfaceKey) return
              event.dataTransfer.setData(SESSION_SURFACE_DND_MIME, chat.surfaceKey)
              event.dataTransfer.effectAllowed = "move"
            }}
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
          </Fragment>
        )
      })}
      {launchers.length > 0 ? (
        <DropdownMenu.Root open={launcherOpen} onOpenChange={setLauncherOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="New tab"
              title="New tab (⌘T)"
              className="flex flex-none items-center rounded-md px-1.5 py-1.5 text-dim outline-none transition-colors hover:bg-panel hover:text-text"
            >
              <Plus className="size-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 flex min-w-[220px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
            >
              {launchers.map((item, index) => (
                <DropdownMenu.Item
                  key={item.id}
                  onSelect={item.onSelect}
                  data-testid={`new-tab-option-${item.id}`}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                >
                  <item.icon className="size-3.5 flex-none text-dim" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {index < 9 ? <span className="font-mono text-[10px] text-dim">{index + 1}</span> : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={onCreateChat}
          className="flex flex-none items-center rounded-md px-1.5 py-1.5 text-dim outline-none transition-colors hover:bg-panel hover:text-text"
        >
          <Plus className="size-3.5" />
        </button>
      )}
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
      {viewCount > 0 && (() => {
        const viewsGroupLabel = (
          <button
            type="button"
            aria-label={`${viewsExpanded ? "Collapse" : "Expand"} views group`}
            aria-expanded={viewsExpanded}
            title={`${viewCount} open ${viewCount === 1 ? "view" : "views"}`}
            onClick={() => setViewsExpanded((expanded) => !expanded)}
            className={cn(
              "flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors hover:bg-panel hover:text-text-bright",
              viewsActive ? "bg-panel text-text-bright" : "text-muted-foreground"
            )}
          >
            <ChevronRight className={cn("size-3 transition-transform", viewsExpanded && "rotate-90")} />
            <Layers3 className="size-3 text-green" />
            <span>Views</span>
            <span className="text-dim">{viewCount}</span>
          </button>
        )
        return onCloseAllViews ? (
          <GroupContextMenu label="Close all views" onSelect={onCloseAllViews}>
            {viewsGroupLabel}
          </GroupContextMenu>
        ) : (
          viewsGroupLabel
        )
      })()}
      {viewsExpanded ? viewSlot : null}
      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        items={commandItems}
        placeholder="Choose a tab type…"
        emptyMessage="No tab types available"
        testId="new-tab-command-menu"
      />
    </>
  )
}
