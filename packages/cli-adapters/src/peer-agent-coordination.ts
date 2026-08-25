import type { PeerAgentMessageResult } from "@jingler/core"
import { Effect } from "effect"

export interface PeerChat {
  readonly id: string
  readonly title: string | null
}

export const routePeerAgentMessage = <E, R>(
  chats: ReadonlyArray<PeerChat>,
  fromChatId: string,
  toChatId: string,
  text: string,
  deliver: (targetChatId: string, attributedText: string) => Effect.Effect<boolean, E, R>
): Effect.Effect<PeerAgentMessageResult, E, R> => {
  const sender = chats.find((chat) => chat.id === fromChatId)
  const target = chats.find((chat) => chat.id === toChatId)
  const body = text.trim()
  if (
    sender === undefined ||
    target === undefined ||
    fromChatId === toChatId ||
    body === ""
  ) return Effect.succeed({ status: "rejected", targetChatId: toChatId })
  return deliver(
    toChatId,
    `[Peer message from ${sender.title ?? fromChatId} (${fromChatId})]\n${body}`
  ).pipe(
    Effect.map((delivered) => ({
      status: delivered ? "delivered" as const : "unavailable" as const,
      targetChatId: toChatId
    }))
  )
}
