import type {
  PlanAnnotation,
  PlanCommentMentionDelivery,
  PlanCommentMessage,
  PlanCommentMessageDeliveryState,
  PlanPrd,
  PlanAcceptanceStatus,
  PlanTaskStatus
} from "@jingler/core"

/**
 * Structured plan mutations — the DTO counterpart of the deleted HTML mutators
 * (`updatePlanCriterionHtml`, `appendPlanAnnotationHtml`, …). Each returns a new
 * `PlanPrd`, or `null` when the target id was not found so callers can surface a
 * precise validation error instead of silently no-op-ing.
 */

export const setCriterionStatus = (
  plan: PlanPrd,
  criterionId: string,
  status: PlanAcceptanceStatus,
  evidence: string | null
): PlanPrd | null => {
  let found = false
  const stages = plan.stages.map((stage) => ({
    ...stage,
    acceptance: stage.acceptance.map((criterion) => {
      if (criterion.id !== criterionId) return criterion
      found = true
      return { ...criterion, status, evidence }
    })
  }))
  return found ? { ...plan, stages } : null
}

/** Set one task's mechanical progress without changing any stage semantics. */
export const setTaskStatus = (
  plan: PlanPrd,
  stageId: string,
  taskId: string,
  status: PlanTaskStatus
): PlanPrd | null => {
  let found = false
  const stages = plan.stages.map((stage) => {
    if (stage.id !== stageId) return stage
    const tasks = (stage.tasks ?? []).map((task) => {
      if (task.id !== taskId) return task
      found = true
      return { ...task, status }
    })
    return found ? { ...stage, tasks } : stage
  })
  return found ? { ...plan, stages } : null
}

export const appendAnnotation = (plan: PlanPrd, annotation: PlanAnnotation): PlanPrd => ({
  ...plan,
  annotations: [...plan.annotations, annotation]
})

const mapAnnotation = (
  plan: PlanPrd,
  annotationId: string,
  update: (annotation: PlanAnnotation) => PlanAnnotation
): PlanPrd | null => {
  let found = false
  const annotations = plan.annotations.map((annotation) => {
    if (annotation.id !== annotationId) return annotation
    found = true
    return update(annotation)
  })
  return found ? { ...plan, annotations } : null
}

export const appendCommentMessage = (
  plan: PlanPrd,
  annotationId: string,
  message: PlanCommentMessage
): PlanPrd | null =>
  mapAnnotation(plan, annotationId, (annotation) => ({
    ...annotation,
    messages: [...annotation.messages, message]
  }))

const mapMessage = (
  plan: PlanPrd,
  annotationId: string,
  messageId: string,
  update: (message: PlanCommentMessage) => PlanCommentMessage
): PlanPrd | null => {
  let messageFound = false
  const result = mapAnnotation(plan, annotationId, (annotation) => ({
    ...annotation,
    messages: annotation.messages.map((message) => {
      if (message.id !== messageId) return message
      messageFound = true
      return update(message)
    })
  }))
  return result !== null && messageFound ? result : null
}

export const updateMessageDelivery = (
  plan: PlanPrd,
  annotationId: string,
  messageId: string,
  deliveryState: PlanCommentMessageDeliveryState
): PlanPrd | null =>
  mapMessage(plan, annotationId, messageId, (message) => ({ ...message, deliveryState }))

export const updateMentionDeliveries = (
  plan: PlanPrd,
  annotationId: string,
  messageId: string,
  deliveries: ReadonlyArray<PlanCommentMentionDelivery>,
  deliveryState: PlanCommentMessageDeliveryState
): PlanPrd | null =>
  mapMessage(plan, annotationId, messageId, (message) => ({
    ...message,
    deliveryState,
    mentionDeliveries: [...deliveries]
  }))

export const setAnnotationStatus = (
  plan: PlanPrd,
  annotationId: string,
  status: "open" | "resolved"
): PlanPrd | null =>
  mapAnnotation(plan, annotationId, (annotation) => ({ ...annotation, status }))

/** Resolve every routed annotation in one pass (comments handed to the agent). */
export const resolveAnnotations = (
  plan: PlanPrd,
  annotationIds: ReadonlySet<string>
): PlanPrd => ({
  ...plan,
  annotations: plan.annotations.map((annotation) =>
    annotationIds.has(annotation.id) ? { ...annotation, status: "resolved" } : annotation
  )
})
