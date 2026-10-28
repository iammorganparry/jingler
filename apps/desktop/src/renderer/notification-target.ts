/**
 * Where a notification click should land: which session, and whether the
 * question it was about is still there to focus.
 *
 * Pure so the "is this turn still the pending one" rule — the only part worth
 * getting wrong — is testable without a session, a machine, or the DOM.
 */
export interface NotificationClick {
  readonly sessionId: string
  readonly turnId: string | null
}

export interface NotificationTarget {
  readonly sessionId: string
  /** Scroll to and focus the turn's question card — only when it's still pending. */
  readonly focusQuestion: boolean
}

/**
 * `pendingQuestionTurnId` is the active chat's current pending question (if
 * any), read by the caller from `pendingQuestion(messages)?.id` — see
 * `@jingler/core`. A stale click (the question was answered, or another one is
 * now pending) must not steal focus onto the wrong card, so this only reports
 * `focusQuestion: true` when the click's turn IS that pending question.
 */
export const notificationTarget = (
  click: NotificationClick,
  pendingQuestionTurnId: string | null
): NotificationTarget => ({
  sessionId: click.sessionId,
  focusQuestion: click.turnId !== null && click.turnId === pendingQuestionTurnId
})
