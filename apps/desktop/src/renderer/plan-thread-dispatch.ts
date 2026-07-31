import type { PlanCommentMessage } from "@jingler/core"

export const planThreadDispatchKey = (
  planId: string,
  annotationId: string
): string => `${planId}:${annotationId}`

// Module-scoped so an in-flight RPC remains leased if its ConversationPane is
// briefly unmounted and remounted while Plan.watch publishes the pending write.
const directThreadDispatches = new Map<string, number>()

export const runWithDirectPlanThreadDispatch = async <T>(
  planId: string,
  annotationId: string,
  dispatch: () => Promise<T>
): Promise<T> => {
  const key = planThreadDispatchKey(planId, annotationId)
  directThreadDispatches.set(key, (directThreadDispatches.get(key) ?? 0) + 1)
  try {
    return await dispatch()
  } finally {
    const remaining = (directThreadDispatches.get(key) ?? 1) - 1
    if (remaining === 0) directThreadDispatches.delete(key)
    else directThreadDispatches.set(key, remaining)
  }
}

export const shouldRecoverPendingPlanMessage = ({
  planId,
  annotationId,
  message,
  recoveredMessageDispatches
}: {
  readonly planId: string
  readonly annotationId: string
  readonly message: PlanCommentMessage
  readonly recoveredMessageDispatches: ReadonlySet<string>
}): boolean =>
  message.authorKind === "user" &&
  message.deliveryState === "pending" &&
  message.mentionedParticipantIds.length > 0 &&
  !directThreadDispatches.has(planThreadDispatchKey(planId, annotationId)) &&
  !recoveredMessageDispatches.has(`${planId}:${message.id}`)
