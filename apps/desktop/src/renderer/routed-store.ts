/**
 * A tiny cross-component store of which PR timeline entries have been routed to a
 * session's agent, so the "Send to agent" action stays in its terminal "Sent"
 * state even after the Pull Request tab unmounts/remounts. Mirrors the
 * session-status store pattern.
 */
import { useSyncExternalStore } from "react"

let routed: Record<string, ReadonlySet<string>> = {}
const listeners = new Set<() => void>()
const EMPTY: ReadonlySet<string> = new Set()

const scope = (sessionId: string, prNumber: number) => `${sessionId}:${prNumber}`

/** Record that `entryId` has been routed for this session + PR scope. */
export const markRouted = (sessionId: string, prNumber: number, entryId: string): void => {
  const key = scope(sessionId, prNumber)
  const current = routed[key] ?? EMPTY
  if (current.has(entryId)) return
  const next = new Set(current)
  next.add(entryId)
  routed = { ...routed, [key]: next }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The set of entry ids already routed for a session (reactive). */
export const useRoutedEntries = (
  sessionId: string,
  prNumber: number | null
): ReadonlySet<string> => {
  const key = prNumber === null ? null : scope(sessionId, prNumber)
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY : (routed[key] ?? EMPTY)),
    () => (key === null ? EMPTY : (routed[key] ?? EMPTY))
  )
}
