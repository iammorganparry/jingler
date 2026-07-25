/**
 * Module-level registry of in-flight "Deslop" cleanup sessions.
 *
 * The concurrency cap has to live here, not in `ReviewPane` state: the pane is
 * mounted only while the Code Review tab is active and is keyed per session+PR,
 * while the deslop sessions it spawns keep running in the module-level
 * conversation-actor registry across unmounts. A per-pane counter would reset to
 * empty on every tab/session switch, letting the user spawn another full batch —
 * so `maxConcurrentSubAgents` would not actually bound concurrent sessions. A
 * single module-level set makes the ceiling global, as the setting promises.
 */
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export const deslopTracker = {
  /** Mark a freshly-spawned deslop session as running. */
  add(sessionId: string): void {
    inFlight.add(sessionId)
    emit()
  },
  /** Release a deslop session's slot once its turn has settled. */
  remove(sessionId: string): void {
    if (inFlight.delete(sessionId)) emit()
  },
  /** How many deslop sessions are currently running, across every pane. */
  count(): number {
    return inFlight.size
  },
  /** Subscribe to count changes (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}
