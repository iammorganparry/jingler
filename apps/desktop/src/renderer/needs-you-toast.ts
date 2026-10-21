import type { ToastInput } from "@jingler/ui"

export interface BlockedSession {
  readonly sessionId: string
  readonly title: string
  readonly body: string
}

/**
 * The "Needs you" toast for a run that just blocked, or null when the operator
 * can already see that session (it would only tell them what's on screen).
 */
export const needsYouToast = (
  blocked: BlockedSession,
  isVisible: boolean,
  jump: () => void
): ToastInput | null =>
  isVisible
    ? null
    : {
        key: `needs-you:${blocked.sessionId}`,
        variant: "needs-you",
        title: blocked.title,
        description: blocked.body,
        action: { label: "Jump", onAction: jump },
        sessionId: blocked.sessionId
      }
