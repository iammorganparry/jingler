/**
 * The session's chat pills, dropped into the main tab row's `chatSlot`.
 *
 * Lifted OUT of `ConversationPane` and into its own component so the pills can be
 * threaded down to `TabBar` through `renderChatTabs` (see `SessionPane`) rather
 * than rendered inside the transcript column. The handlers here are 3-line RPC
 * calls that also live in `ConversationPane` (its ⌘T/⌘W/⌘1-9 shortcuts still need
 * them); the duplication is intended — both places drive the same session store
 * and there is nothing shared to hoist that would be simpler than the calls.
 */
import type { Session } from "@jingler/core"
import { ChatTabBar, FileIcon } from "@jingler/ui"
import { X } from "lucide-react"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import { disposeChatActor, rehomeSharedPlan, useChatActivities } from "./conversation-registry.js"
import { clearDraft } from "./draft-store.js"
import { useFileBrowser } from "./use-file-browser.js"

export function SessionChatTabs({
  session,
  filesActive,
  onSelectConversation,
  onSelectFiles
}: {
  session: Session
  filesActive: boolean
  onSelectConversation: () => void
  onSelectFiles: () => void
}) {
  const activeChat =
    session.chats.find((chat) => chat.id === session.activeChatId) ??
    session.chats[0]!
  const chatActivities = useChatActivities(session.id)
  const files = useFileBrowser(session.id, session.worktreePath)

  const createChat = () => {
    void rpc.sessionsCreateChat(session.id).then(publishSessionUpdate)
  }
  const selectChat = (chatId: string) => {
    onSelectConversation()
    if (chatId === activeChat.id) return
    void rpc.sessionsSelectChat(session.id, chatId).then(publishSessionUpdate)
  }
  const renameChat = (chatId: string, title: string) => {
    void rpc.sessionsRenameChat(session.id, chatId, title).then(publishSessionUpdate)
  }
  const closeChat = (chatId: string) => {
    void rpc.sessionsCloseChat(session.id, chatId).then((updated) => {
      clearDraft(chatId)
      rehomeSharedPlan(session.id, chatId, updated.activeChatId)
      disposeChatActor(session.id, chatId)
      publishSessionUpdate(updated)
    }).catch(() => {})
  }
  const reopenChat = (chatId: string) => {
    onSelectConversation()
    void rpc.sessionsReopenChat(session.id, chatId).then(publishSessionUpdate)
  }

  const selectFile = (path: string) => {
    files.open(path)
    onSelectFiles()
  }
  const closeFile = (path: string) => {
    const active = path === files.selectedPath
    const closingLast = files.openPaths.length === 1
    files.close(path)
    if (!active) return
    if (files.dirty) {
      onSelectFiles()
      return
    }
    if (closingLast) onSelectConversation()
    else onSelectFiles()
  }
  const duplicateNames = new Set(
    files.openPaths
      .map((path) => path.split("/").at(-1) ?? path)
      .filter((name, index, names) => names.indexOf(name) !== index)
  )
  const fileSlot = files.openPaths.map((path) => {
    const name = path.split("/").at(-1) ?? path
    const active = filesActive && path === files.selectedPath
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    return (
      <div
        key={path}
        data-testid={`file-tab-${path}`}
        className={
          active
            ? "group flex flex-none items-center rounded-md bg-panel text-text-bright"
            : "group flex flex-none items-center rounded-md text-muted-foreground transition-colors hover:bg-panel/60 hover:text-text"
        }
      >
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          aria-label={path}
          title={path}
          onClick={() => selectFile(path)}
          className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 text-left text-xs outline-none"
        >
          <FileIcon path={path} size={12} />
          <span className="max-w-[150px] truncate">{name}</span>
          {duplicateNames.has(name) && parent !== "" ? (
            <span className="max-w-[100px] truncate text-dim">{parent}</span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label={`Close ${path}`}
          title={`Close ${path}`}
          onClick={() => closeFile(path)}
          className="mr-1 rounded p-0.5 text-dim opacity-0 outline-none hover:bg-editor hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  })

  return (
    <ChatTabBar
      chats={session.chats.map((chat, index) => ({
        id: chat.id,
        title: chat.title ?? `Chat ${index + 1}`,
        running: chatActivities[chat.id] !== undefined
      }))}
      closedChats={(session.closedChats ?? []).map((chat, index) => ({
        id: chat.id,
        title: chat.title ?? `Closed chat ${index + 1}`
      }))}
      activeChatId={filesActive ? "" : activeChat.id}
      onSelectChat={selectChat}
      onCreateChat={createChat}
      onRenameChat={renameChat}
      onCloseChat={closeChat}
      onReopenChat={reopenChat}
      fileSlot={fileSlot}
    />
  )
}
