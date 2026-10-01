/**
 * A session's chats, chat-owned views, open files and open session views,
 * listed under its sidebar row.
 *
 * Reads the editor layout through a string selector (the sorted open keys), so
 * switching tabs inside a group never re-renders the sidebar — only opening or
 * closing something does.
 */
import { memo, useState } from "react"
import { useSelector } from "@xstate/react"
import type { ProviderId, Session, SessionActivity } from "@jingler/core"
import { Pencil, RotateCcw, X } from "lucide-react"
import { ContextMenu } from "../components/context-menu.js"
import { cn } from "../lib/cn.js"
import { FileIcon } from "../components/file-icon.js"
import { ProviderIcon, providerLabel } from "../components/provider-icon.js"
import { allTabs, closeSurfaceEverywhere, loadEditorLayout, openTab } from "./editor-layout.js"
import { editorLayoutOf, editorLayouts, initEditorLayout, updateEditorLayout } from "./editor-layout-machine.js"
import { editorTabMime } from "./editor-groups.js"
import { BUILTIN_TAB_META, type BuiltinTabKey } from "./tab-contributions.js"
import { parseSessionSurfaceKey, sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"

const openKeysOf = (sessionId: string) => (snapshot: ReturnType<typeof editorLayouts.getSnapshot>) => {
  const layout = snapshot.context.layouts[sessionId]
  return layout ? allTabs(layout).map(sessionSurfaceKey).join("\n") : ""
}

/** Seeds the layout from storage when the session's pane has never mounted. */
const ensureLayout = (session: Session) => {
  if (editorLayoutOf(session.id)) return
  const main = session.chats[0]?.id
  initEditorLayout(session.id, loadEditorLayout(session.id, { kind: "chat", id: session.activeChatId }, main))
}

const viewMeta = (id: string) => BUILTIN_TAB_META[id as BuiltinTabKey] as (typeof BUILTIN_TAB_META)[BuiltinTabKey] | undefined

/** Chat lifecycle actions owned by the host (they are RPCs there). */
export interface SessionChatActions {
  readonly onRenameChat?: (sessionId: string, chatId: string, title: string) => void
  /** Makes this chat canonical for session-owned actions. */
  readonly onSelectChat?: (sessionId: string, chatId: string) => void
  /** Closes the chat itself (it moves to Closed), not just its tabs. */
  readonly onCloseChat?: (sessionId: string, chatId: string) => void
  readonly onReopenChat?: (sessionId: string, chatId: string) => void
}

export const SessionTree = memo(function SessionTree({
  session,
  running,
  activityByChat,
  onSelectSession,
  chatActions,
  onRequestCloseFile,
  onCloseView
}: {
  session: Session
  /** Session-level fallback for hosts without per-chat activity. */
  running: boolean
  activityByChat?: Readonly<Record<string, SessionActivity>>
  onSelectSession: (id: string) => void
  chatActions?: SessionChatActions
  onRequestCloseFile?: (sessionId: string, path: string) => boolean
  onCloseView?: (sessionId: string, surface: Extract<SessionSurface, { kind: "view" }>) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [closedOpen, setClosedOpen] = useState(false)
  const closed = session.closedChats ?? []
  const commitRename = (chatId: string) => {
    if (draft.trim()) chatActions?.onRenameChat?.(session.id, chatId, draft.trim())
    setRenaming(null)
  }
  const openKeys = useSelector(editorLayouts, openKeysOf(session.id))
  const open = openKeys
    ? openKeys.split("\n").flatMap((key) => {
        const surface = parseSessionSurfaceKey(key)
        return surface ? [surface] : []
      })
    : []
  const openSet = new Set(openKeys.split("\n"))

  const openItem = (surface: SessionSurface) => {
    ensureLayout(session)
    updateEditorLayout(session.id, (layout) => openTab(layout, surface, session.chats[0]?.id))
    if (surface.kind === "chat") chatActions?.onSelectChat?.(session.id, surface.id)
    onSelectSession(session.id)
  }
  const closeItem = (surface: SessionSurface) => {
    if (surface.kind === "file" && onRequestCloseFile && !onRequestCloseFile(session.id, surface.id)) {
      ensureLayout(session)
      updateEditorLayout(session.id, (layout) => openTab(layout, surface, session.chats[0]?.id))
      onSelectSession(session.id)
      return
    }
    if (surface.kind === "view") onCloseView?.(session.id, surface)
    updateEditorLayout(session.id, (layout) => closeSurfaceEverywhere(layout, surface))
  }

  const item = (surface: SessionSurface, label: string, icon: React.ReactNode, trailing?: React.ReactNode) => {
    const isOpen = openSet.has(sessionSurfaceKey(surface))
    return (
      <div
        key={sessionSurfaceKey(surface)}
        data-testid={`session-tree-${surface.kind}-${surface.id}`}
        className={cn(
          "group/item flex items-center rounded text-[12px] hover:bg-surface/40",
          isOpen ? "text-text" : "text-muted-foreground hover:text-text"
        )}
      >
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            ensureLayout(session)
            e.dataTransfer.setData(editorTabMime(session.id), JSON.stringify({ surface }))
            e.dataTransfer.effectAllowed = "copyMove"
          }}
          onClick={() => openItem(surface)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left outline-none"
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
        </button>
        {isOpen ? (
          <button
            type="button"
            aria-label={`Close ${label} everywhere`}
            title="Close in every group"
            onClick={() => closeItem(surface)}
            className="mr-1 flex-none rounded p-0.5 text-dim opacity-0 outline-none hover:bg-surface hover:text-text focus-visible:opacity-100 group-hover/item:opacity-100"
          >
            <X className="size-3" />
          </button>
        ) : (
          // Same footprint as the close button so trailing icons never shift.
          <span aria-hidden className="mr-1 size-4 flex-none" />
        )}
      </div>
    )
  }

  const viewItem = (surface: Extract<SessionSurface, { kind: "view" }>) => {
    const meta = viewMeta(surface.id)
    const Icon = meta?.icon
    return item(surface, meta?.label ?? surface.id, Icon ? <Icon className="size-3 flex-none text-green" /> : null)
  }
  const views = open.filter((s): s is Extract<SessionSurface, { kind: "view" }> => s.kind === "view")
  const files = open.filter((s) => s.kind === "file")
  const sessionViews = views.filter((v) => !v.chatId)
  const isChatBusy = (chatId: string) =>
    activityByChat ? activityByChat[chatId] !== undefined : running && chatId === session.activeChatId

  return (
    <div data-testid={`session-tree-${session.id}`} className="ml-[18px] border-l border-line pb-1 pl-1">
      {session.chats.map((chat, index) => {
        const surface: SessionSurface = { kind: "chat", id: chat.id }
        const owned = views.filter((v) => v.chatId === chat.id)
        const busy = isChatBusy(chat.id)
        const title = chat.title ?? `Chat ${index + 1}`
        if (renaming === chat.id) {
          return (
            <input
              key={chat.id}
              aria-label="Chat title"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(chat.id)
                else if (e.key === "Escape") setRenaming(null)
              }}
              onBlur={() => commitRename(chat.id)}
              className="my-0.5 w-full rounded border border-blue/50 bg-editor px-2 py-0.5 text-[12px] text-text-bright outline-none"
            />
          )
        }
        const menu = [
          ...(chatActions?.onRenameChat
            ? [{ label: "Rename chat", icon: Pencil, onSelect: () => { setDraft(title); setRenaming(chat.id) } }]
            : []),
          ...(chatActions?.onCloseChat
            ? [{ label: "Close chat", icon: X, onSelect: () => chatActions.onCloseChat?.(session.id, chat.id) }]
            : [])
        ]
        const row = (
          <div
            onDoubleClick={() => {
              if (!chatActions?.onRenameChat) return
              setDraft(title)
              setRenaming(chat.id)
            }}
          >
            {item(
              surface,
              title,
              <span
                role="img"
                aria-label={busy ? "Running" : "Idle"}
                className={cn("size-1.5 flex-none rounded-full", busy ? "bg-yellow" : "bg-dim")}
              />,
              <span title={providerLabel(chat.providerId as ProviderId | undefined)} className="flex flex-none">
                <ProviderIcon providerId={chat.providerId as ProviderId | undefined} size={11} />
              </span>
            )}
          </div>
        )
        return (
          <div key={chat.id}>
            {menu.length > 0 ? <ContextMenu items={menu}>{row}</ContextMenu> : row}
            {owned.length > 0 && <div className="ml-3 border-l border-hairline pl-1">{owned.map(viewItem)}</div>}
          </div>
        )
      })}
      {files.length > 0 && (
        <>
          <p className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-dim">Files</p>
          {files.map((f) => item(f, f.id.split("/").at(-1) ?? f.id, <FileIcon path={f.id} size={12} />))}
        </>
      )}
      {closed.length > 0 && chatActions?.onReopenChat && (
        <>
          <button
            type="button"
            aria-expanded={closedOpen}
            onClick={() => setClosedOpen((v) => !v)}
            className="px-2 pb-0.5 pt-1.5 text-left text-[10px] uppercase tracking-wider text-dim hover:text-text"
          >
            Closed ({closed.length})
          </button>
          {closedOpen &&
            closed.map((chat, index) => (
              <button
                key={chat.id}
                type="button"
                aria-label={`Reopen ${chat.title ?? `Closed chat ${index + 1}`}`}
                onClick={() => {
                  chatActions.onReopenChat?.(session.id, chat.id)
                  onSelectSession(session.id)
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-surface/40 hover:text-text"
              >
                <RotateCcw className="size-3 flex-none text-dim" />
                <span className="truncate">{chat.title ?? `Closed chat ${index + 1}`}</span>
              </button>
            ))}
        </>
      )}
      {sessionViews.length > 0 && (
        <>
          <p className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-dim">Session views</p>
          {sessionViews.map(viewItem)}
        </>
      )}
    </div>
  )
})
