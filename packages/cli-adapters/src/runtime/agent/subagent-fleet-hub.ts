import type { SubagentFleetEvent } from "@jingler/core"
import { Effect, Stream } from "effect"

type Listener = (event: SubagentFleetEvent) => void

// ponytail: process-wide map, fine while the main process owns every retained session.
const listeners = new Map<string, Set<Listener>>()
const keyOf = (sessionId: string, chatId: string) => `${sessionId}\u0000${chatId}`

/** Deliver a fleet event to the chat's watchers; used once no turn stream is listening. */
export const publishChatFleetEvent = (
  sessionId: string,
  chatId: string,
  event: SubagentFleetEvent
): void => {
  for (const listener of listeners.get(keyOf(sessionId, chatId)) ?? []) listener(event)
}

/** Fleet events for one chat that arrive outside its turns. */
export const watchChatFleet = (
  sessionId: string,
  chatId: string
): Stream.Stream<SubagentFleetEvent> =>
  Stream.async<SubagentFleetEvent>((emit) => {
    const key = keyOf(sessionId, chatId)
    const listener: Listener = (event) => void emit.single(event)
    const set = listeners.get(key) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(key, set)
    return Effect.sync(() => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    })
  })
