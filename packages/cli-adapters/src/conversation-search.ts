import { activeCheckoutOf, normalizeConversationQuery, type ConversationSearchHit, type ConversationSearchPage, type Session } from "@jingler/core"
import { Effect } from "effect"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"

interface SearchInput {
  readonly query: string
  readonly sessionId?: string
  readonly chatId?: string
  /** Host-owned scope for agent tools; an empty set searches nothing. */
  readonly sessionIds?: ReadonlySet<string>
}
const RESULT_LIMIT = 20

const chatsForSearch = (session: Session, chatId: string | undefined) =>
  [...session.chats, ...(session.closedChats ?? [])]
    .filter((chat) => chatId === undefined || chat.id === chatId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

const searchSession = (session: Session, input: SearchInput, query: string, limit: number) => Effect.gen(function* () {
  const hits: ConversationSearchHit[] = []
  for (const chat of chatsForSearch(session, input.chatId)) {
    if (chat.id === `c_${session.id}_1`) yield* TranscriptStore.adoptLegacy(session.id, chat.id)
    const matches = yield* TranscriptStore.search(chat.id, query, limit - hits.length)
    hits.push(...matches.map((match) => ({
      ...match,
      sessionId: session.id,
      chatId: chat.id,
      sessionTitle: session.title || "Untitled workspace",
      chatTitle: chat.title ?? "Untitled chat",
      repo: activeCheckoutOf(session).repo
    })))
    if (hits.length >= limit) break
    yield* Effect.yieldNow()
  }
  return hits
})

/** Saved text on this device only. Never enumerate native CLI stores or remote hosts. */
export const searchConversations = (input: SearchInput) => Effect.gen(function* () {
  const query = normalizeConversationQuery(input.query)
  if (query.length < 3 || query.length > 160) return { hits: [], hasMore: false } satisfies ConversationSearchPage
  const sessions = [...(yield* SessionStore.list())]
    .filter((session) => !session.environmentId &&
      (input.sessionId === undefined || session.id === input.sessionId) &&
      (input.sessionIds === undefined || input.sessionIds.has(session.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const hits: ConversationSearchHit[] = []
  for (const session of sessions) {
    hits.push(...(yield* searchSession(session, input, query, RESULT_LIMIT + 1 - hits.length)))
    if (hits.length > RESULT_LIMIT) return { hits: hits.slice(0, RESULT_LIMIT), hasMore: true }
    yield* Effect.yieldNow()
  }
  return { hits, hasMore: false }
})
