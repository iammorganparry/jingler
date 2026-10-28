import { useEffect, useSyncExternalStore } from "react"
import { rpc } from "./rpc-client.js"

export interface InterruptedChat {
  readonly sessionId: string
  readonly chatId: string
}

/** Chats whose last run was cut off by a restart. Loaded once; only ever shrinks. */
let chats: ReadonlyArray<InterruptedChat> = []
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

export const setInterruptedChats = (next: ReadonlyArray<InterruptedChat>): void => {
  chats = next
  emit()
}

/** Drop a chat (or every chat of a session when `chatId` is omitted) once it is live again. */
export const clearInterruptedChat = (sessionId: string, chatId?: string): void => {
  const next = chats.filter((c) => c.sessionId !== sessionId || (chatId !== undefined && c.chatId !== chatId))
  if (next.length === chats.length) return
  chats = next
  emit()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => chats

/** Fetch the interrupted chats once at startup (read-only; nothing is persisted). */
export const useInterruptedChatsLoader = (): void => {
  useEffect(() => {
    void rpc.sessionsInterruptedChats().then(setInterruptedChats).catch(() => {})
  }, [])
}

export const useInterruptedChats = (): ReadonlyArray<InterruptedChat> =>
  useSyncExternalStore(subscribe, snapshot, snapshot)
