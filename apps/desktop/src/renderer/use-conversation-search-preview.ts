import { CONVERSATION_SEARCH_PAGE_SIZE, type Session } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useEffect } from "react"
import { fromPromise } from "xstate"
import { conversationSearchPreviewMachine, conversationSearchPreviewPage, type ConversationSearchTarget } from "./conversation-search-preview-machine.js"
import { rpc } from "./rpc-client.js"
import type { Conversation } from "./use-conversation.js"

const previewLogic = conversationSearchPreviewMachine.provide({
  actors: { load: fromPromise(async ({ input, signal }) => {
    const page = await rpc.sessionsTranscriptPage(input.sessionId, input.chatId, input.before, CONVERSATION_SEARCH_PAGE_SIZE, signal)
    return conversationSearchPreviewPage(page.messages, input)
  }) }
})

const sameTarget = (left: ConversationSearchTarget | null, right: ConversationSearchTarget | null) =>
  left !== null && right !== null && left.nonce === right.nonce && left.sessionId === right.sessionId &&
  left.chatId === right.chatId && left.messageId === right.messageId && left.before === right.before && left.messageIndex === right.messageIndex && left.query === right.query

const PREVIEW_LABELS = {
  closed: "Opening search result…",
  loading: "Opening search result…",
  ready: "Viewing saved conversation text",
  missing: "This message changed or was removed. Search again to find it.",
  failed: "Could not open this saved conversation. Search again to retry."
}

export function useConversationSearchPreview(session: Session, requested: ConversationSearchTarget | null | undefined, conversation: Conversation) {
  const target = requested?.sessionId === session.id && requested.chatId === session.activeChatId ? requested : null
  const [state, send] = useMachine(previewLogic)
  useEffect(() => {
    if (target) send({ type: "OPEN", target })
    else send({ type: "CLOSE" })
  }, [target, send])
  const current = sameTarget(target, state.context.target)
  const ready = current && state.matches("ready")
  const failed = current && (state.matches("missing") || state.matches("failed"))
  const page = ready ? state.context.page : null
  return {
    active: target !== null,
    // Each saved window owns fresh row measurements and pending scroll work.
    viewKey: page ? `search:${target!.nonce}` : "live",
    conversation: page ? { ...conversation, messages: page.messages, hasMoreHistory: false, loadingHistory: false } : conversation,
    focusIndex: page?.focusIndex,
    query: page ? target!.query : undefined,
    requestNonce: target?.nonce,
    failed,
    label: PREVIEW_LABELS[current ? state.value : "loading"]
  }
}
