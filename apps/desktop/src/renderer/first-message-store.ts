/**
 * A one-shot handoff for a freshly created session's FIRST turn.
 *
 * When a workspace is created from the new-session composer, its typed text
 * rides through as the persisted `initialPrompt`, but its image attachments do
 * not — images are never session metadata. This module-scoped map carries those
 * images (and, by its mere presence, the "auto-send this session's first turn"
 * intent) from `createSession` to the `ConversationPane` that mounts moments
 * later. The pane `take`s the entry exactly once and dispatches the turn.
 *
 * Module-scoped for the same reason `draft-store` is: the pane is keyed by
 * session id and remounts across tab/pane switches, so per-component state can't
 * survive the gap between creation and first paint. The entry is renderer-only
 * and intentionally not persisted — an app restart before the first turn lands
 * simply falls back to `initialPrompt` seeding the composer as a draft.
 */
import type { Attachment } from "@jingler/core"

const pending = new Map<string, ReadonlyArray<Attachment>>()

/**
 * Mark a just-created session for first-turn auto-send, carrying its first
 * turn's image attachments (empty array for a text-only first message).
 */
export const setFirstMessage = (sessionId: string, images: ReadonlyArray<Attachment>): void => {
  pending.set(sessionId, images)
}

/**
 * Consume the pending first-turn handoff for a session, or `undefined` if none
 * (a session opened without a first message, or one already sent). Presence is
 * the auto-send signal; the value is the attachments to send.
 */
export const takeFirstMessage = (sessionId: string): ReadonlyArray<Attachment> | undefined => {
  const images = pending.get(sessionId)
  if (images === undefined) return undefined
  pending.delete(sessionId)
  return images
}
