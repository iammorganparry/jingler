import { Schema } from "effect"
import type { Message } from "./conversation.js"

/** Search cursors must be reopened with the same page size to preserve message positions. */
export const CONVERSATION_SEARCH_PAGE_SIZE = 200

/** A bounded text result; the cursor reopens just the page containing the hit. */
export const ConversationSearchHit = Schema.Struct({
  sessionId: Schema.String,
  chatId: Schema.String,
  messageId: Schema.String,
  messageIndex: Schema.Int.pipe(Schema.between(0, CONVERSATION_SEARCH_PAGE_SIZE - 1)),
  before: Schema.String,
  sessionTitle: Schema.String,
  chatTitle: Schema.String,
  repo: Schema.String,
  role: Schema.Literal("user", "assistant"),
  snippet: Schema.String
})
export type ConversationSearchHit = typeof ConversationSearchHit.Type

export const ConversationSearchPage = Schema.Struct({
  hits: Schema.Array(ConversationSearchHit),
  hasMore: Schema.Boolean
})
export type ConversationSearchPage = typeof ConversationSearchPage.Type

const WHITESPACE = /\s+/gu
export const normalizeConversationQuery = (text: string): string => text.replace(WHITESPACE, " ").trim()

export const conversationSearchText = (message: Message): string =>
  normalizeConversationQuery(message.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []).join(" "))

/** Search visible conversation prose. Tool output, thoughts and attachments stay out. */
export function conversationSearchSnippet(message: Message, query: string): string | null {
  if (message.role !== "user" && message.role !== "assistant") return null
  const text = conversationSearchText(message)
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return null
  const start = Math.max(0, at - 60)
  const end = Math.min(text.length, Math.max(start + 220, at + query.length))
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}
