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
export const findInterruptedChats = (
  sessions: ReadonlyArray<Session>,
  chatBusy: (chatId: string) => Effect.Effect<boolean>
) =>
  Effect.gen(function* () {
    const found: Array<InterruptedChat> = []
    for (const session of sessions) {
      if (session.archived) continue
      for (const chat of session.chats) {
        const { messages } = yield* TranscriptStore.listPage(chat.id, { limit: 1 })
        const last = messages.at(-1)
        if (last?.role !== "assistant" || !last.streaming) continue
        if (yield* chatBusy(chat.id)) continue
        found.push({ sessionId: session.id, chatId: chat.id })
      }
    }
    return found
  })
