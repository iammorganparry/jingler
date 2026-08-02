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
import { ChatTabBar } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import { disposeChatActor, rehomeSharedPlan, useChatActivities } from "./conversation-registry.js"
import { clearDraft } from "./draft-store.js"

export function SessionChatTabs({
  session,
  onSelectConversation
}: {
  session: Session
  onSelectConversation: () => void
}) {
  const activeChat =
    session.chats.find((chat) => chat.id === session.activeChatId) ??
    session.chats[0]!
  const chatActivities = useChatActivities(session.id)

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
      activeChatId={activeChat.id}
      onSelectChat={selectChat}
      onCreateChat={createChat}
      onRenameChat={renameChat}
      onCloseChat={closeChat}
      onReopenChat={reopenChat}
    />
  )
}
