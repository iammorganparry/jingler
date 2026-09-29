import type { PlanAnnotation, PlanCommentMessage } from "@jingler/core"

const PREFIX = "jingler.plan-comments.v1:"
export const planCommentStorageKey = (planId: string): string => `${PREFIX}${planId}`

const isMessage = (value: unknown): value is PlanCommentMessage => {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<PlanCommentMessage>
  return typeof message.id === "string" && typeof message.body === "string" &&
    (message.authorKind === "user" || message.authorKind === "agent") &&
    typeof message.authorId === "string" && typeof message.createdAt === "string" &&
    Array.isArray(message.mentionedParticipantIds) &&
    (message.deliveryState === "pending" || message.deliveryState === "sent" || message.deliveryState === "failed")
}

const isAnnotation = (value: unknown): value is PlanAnnotation => {
  if (typeof value !== "object" || value === null) return false
  const annotation = value as Partial<PlanAnnotation>
  const anchor = annotation.anchor
  return typeof annotation.id === "string" &&
    (typeof annotation.stageId === "string" || annotation.stageId === null) &&
    typeof annotation.body === "string" &&
    (annotation.author === "user" || annotation.author === "agent") &&
    typeof annotation.createdAt === "string" &&
    (annotation.status === "open" || annotation.status === "resolved") &&
    Array.isArray(annotation.messages) && annotation.messages.every(isMessage) &&
    (anchor === undefined || (
      typeof anchor === "object" && anchor !== null &&
      typeof anchor.quote === "string" && typeof anchor.prefix === "string" &&
      typeof anchor.suffix === "string"
    ))
}

export const loadPlanComments = (planId: string): ReadonlyArray<PlanAnnotation> => {
  try {
    const raw = localStorage.getItem(planCommentStorageKey(planId))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isAnnotation) : []
  } catch {
    return []
  }
}

export const savePlanComments = (planId: string, comments: ReadonlyArray<PlanAnnotation>): void => {
  try {
    localStorage.setItem(planCommentStorageKey(planId), JSON.stringify(comments))
  } catch {
    // Comments remain usable for this mount when storage is unavailable.
  }
}
