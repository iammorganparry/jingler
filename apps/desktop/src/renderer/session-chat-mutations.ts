import type { Session } from "@jingler/core"
import { publishSessionUpdate } from "./session-updates.js"

const pending = new Map<string, Promise<void>>()

/** Keep active-chat writes and their UI publications in the order the operator made them. */
export const queueSessionChatMutation = (
  sessionId: string,
  mutation: () => Promise<Session>,
  apply: (session: Session) => void = publishSessionUpdate
): void => {
  const previous = pending.get(sessionId)
  const run = previous === undefined
    ? (() => {
        try {
          return mutation()
        } catch (cause) {
          return Promise.reject(cause)
        }
      })()
    : previous.then(mutation)
  const current = run.then(apply).catch(() => {})
  pending.set(sessionId, current)
  current.then(() => {
    if (pending.get(sessionId) === current) pending.delete(sessionId)
  })
}
