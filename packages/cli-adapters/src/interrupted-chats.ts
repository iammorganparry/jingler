import type { Session } from "@jingler/core"
import { Effect } from "effect"
import { TranscriptStore } from "./transcripts.js"

export interface InterruptedChat {
  readonly sessionId: string
  readonly chatId: string
}

/**
 * Chats that were mid-run when the app died: the persisted transcript's LAST
 * message is an assistant turn still flagged `streaming` (only `Done`/`Failed`
 * clear it) while main holds no live turn for the chat. Reads one message per
 * chat via `listPage`, never a whole transcript. Read-only — nothing persisted.
 */
const isInterrupted = (chatId: string, chatBusy: (chatId: string) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const { messages } = yield* TranscriptStore.listPage(chatId, { limit: 1 })
    const last = messages.at(-1)
    if (last?.role !== "assistant" || !last.streaming) return false
    return !(yield* chatBusy(chatId))
  })

export const findInterruptedChats = (
  sessions: ReadonlyArray<Session>,
  chatBusy: (chatId: string) => Effect.Effect<boolean>
) =>
  Effect.filter(
    sessions.filter((session) => !session.archived).flatMap((session) =>
      session.chats.map((chat): InterruptedChat => ({ sessionId: session.id, chatId: chat.id }))
    ),
    ({ chatId }) => isInterrupted(chatId, chatBusy)
  )
