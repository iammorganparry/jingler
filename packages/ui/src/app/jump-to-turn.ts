import { useEffect } from "react"
import type { Message } from "@jingler/core"

/** Window event a file view fires to scroll a chat's transcript to one of its turns. */
export const JUMP_TO_TURN_EVENT = "jingler:jump-to-turn"

export const jumpToTurn = (chatId: string, messageId: string): void => {
  window.dispatchEvent(new CustomEvent(JUMP_TO_TURN_EVENT, { detail: { chatId, messageId } }))
}

/** Calls `jump(index)` when a `jumpToTurn` for this chat names a message that is loaded. */
export function useJumpToTurn(
  chatId: string | undefined,
  messages: ReadonlyArray<Message>,
  jump: (index: number) => void
): void {
  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; messageId: string }>).detail
      if (detail.chatId !== chatId) return
      const index = messages.findIndex((message) => message.id === detail.messageId)
      if (index >= 0) jump(index)
    }
    window.addEventListener(JUMP_TO_TURN_EVENT, onJump)
    return () => window.removeEventListener(JUMP_TO_TURN_EVENT, onJump)
  }, [chatId, messages, jump])
}
