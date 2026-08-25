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
import { AgentRoster, ChatTabBar, FileIcon, SubagentTabBar } from "@jingler/ui"
import { X } from "lucide-react"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import { disposeChatActor, useChatActivities } from "./conversation-registry.js"
import { clearDraft } from "./draft-store.js"
import { useAgentRoster } from "./agent-roster.js"
import { useFileBrowser } from "./use-file-browser.js"
import {
  selectSubagentTab,
  useSessionSubagentTabs
} from "./subagent-tab-store.js"

export function SessionSubagentTabs({
  session,
  onSelectConversation
}: {
  readonly session: Session
  readonly onSelectConversation: () => void
}) {
  const snapshots = useSessionSubagentTabs(session.id)
  const active = snapshots.find(({ chatId }) => chatId === session.activeChatId)
  const subagents = active?.active ?? []
  const roster = useAgentRoster(session)
  return (
    <>
    <SubagentTabBar
      subagents={subagents.map((node) => ({
        id: node.id,
        title: `${node.agent} · ${node.task}`,
        status: node.status === "needs-attention" ? "attention" : "running"
      }))}
      activeSubagentId={active?.selectedId}
      onSelectSubagent={(nodeId) => {
        onSelectConversation()
        selectSubagentTab(session.id, session.activeChatId, nodeId)
      }}
    />
    <AgentRoster
      key={session.activeChatId}
      agents={roster}
      currentChatId={session.activeChatId}
      onMessage={(toChatId, text) =>
        rpc.agentMessagePeer(session.id, session.activeChatId, toChatId, text)
      }
    />
    </>
  )
}

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
  const subagentTabs = useSessionSubagentTabs(session.id)
  const activeSubagents = subagentTabs.find(({ chatId }) => chatId === activeChat.id)
  const previousSubagents = subagentTabs.flatMap(({ chatId, completed }) =>
    completed.map((node) => ({ id: `${chatId}\0${node.id}`, chatId, node }))
  )
  const files = useFileBrowser(session.id, session.worktreePath)

  const createChat = () => {
    void rpc.sessionsCreateChat(session.id).then(publishSessionUpdate)
  }
  const selectChat = (chatId: string) => {
    selectSubagentTab(session.id, chatId, "main")
    if (chatId === activeChat.id) {
      onSelectConversation()
      return
    }
    void rpc.sessionsSelectChat(session.id, chatId).then(publishSessionUpdate)
  }
  const openPreviousSubagent = (id: string) => {
    const previous = previousSubagents.find((candidate) => candidate.id === id)
    if (previous === undefined) return
    onSelectConversation()
    selectSubagentTab(session.id, previous.chatId, previous.node.id)
    if (previous.chatId !== activeChat.id) {
      const closed = session.closedChats?.some(({ id }) => id === previous.chatId) ?? false
      const open = closed ? rpc.sessionsReopenChat : rpc.sessionsSelectChat
      void open(session.id, previous.chatId).then(publishSessionUpdate)
    }
  }
  const renameChat = (chatId: string, title: string) => {
    void rpc.sessionsRenameChat(session.id, chatId, title).then(publishSessionUpdate)
  }
  const closeChat = (chatId: string) => {
    void rpc.sessionsCloseChat(session.id, chatId).then((updated) => {
      clearDraft(chatId)
      disposeChatActor(session.id, chatId)
      publishSessionUpdate(updated)
    }).catch(() => {})
  }
  const reopenChat = (chatId: string) => {
    onSelectConversation()
    void rpc.sessionsReopenChat(session.id, chatId).then(publishSessionUpdate)
  }
  // Sequential on purpose: each close recomputes the active chat, and the
  // store answers the last close with a fresh replacement chat — racing them
  // would interleave those rewrites.
  const closeAllChats = () => {
    void (async () => {
      for (const chat of session.chats) {
        await rpc.sessionsCloseChat(session.id, chat.id).then((updated) => {
          clearDraft(chat.id)
          disposeChatActor(session.id, chat.id)
          publishSessionUpdate(updated)
        }).catch(() => {})
      }
      onSelectConversation()
    })()
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
  const closeAllFiles = () => {
    for (const path of [...files.openPaths]) files.close(path)
    onSelectConversation()
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
      activeChatId={
        filesActive || (activeSubagents !== undefined && activeSubagents.selectedId !== "main")
          ? ""
          : activeChat.id
      }
      onSelectChat={selectChat}
      previousSubagents={previousSubagents.map(({ id, node }) => ({
        id,
        title: `${node.agent} · ${node.task}`
      }))}
      onOpenPreviousSubagent={openPreviousSubagent}
      onCreateChat={createChat}
      onRenameChat={renameChat}
      onCloseChat={closeChat}
      onReopenChat={reopenChat}
      fileSlot={fileSlot}
      filesActive={filesActive}
      onCloseAllChats={closeAllChats}
      onCloseAllFiles={closeAllFiles}
    />
  )
}
