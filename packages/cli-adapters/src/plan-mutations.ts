import type {
  PlanAnnotation,
  PlanCommentMentionDelivery,
  PlanCommentMessage,
  PlanCommentMessageDeliveryState,
  PlanPrd,
  PlanAcceptanceStatus,
  PlanStageExecutionStatus
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

export const setStageExecution = (
  plan: PlanPrd,
  stageId: string,
  status: PlanStageExecutionStatus
): PlanPrd | null => {
  let found = false
  const stages = plan.stages.map((stage) => {
    if (stage.id !== stageId) return stage
    found = true
    return { ...stage, executionStatus: status }
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

/** Create or replace a worker's progress note for a stage. */
export const upsertWorkerAnnotation = (
  plan: PlanPrd,
  input: {
    readonly id: string
    readonly stageId: string
    readonly body: string
    readonly status: "open" | "resolved"
    readonly createdAt: string
    readonly authorId: string
  }
): PlanPrd => {
  const message: PlanCommentMessage = {
    id: `${input.id}-message`,
    body: input.body,
    authorKind: "agent",
    authorId: input.authorId,
    createdAt: input.createdAt,
    mentionedParticipantIds: [],
    deliveryState: "sent"
  }
  const existing = plan.annotations.find((candidate) => candidate.id === input.id)
  if (existing !== undefined) {
    // Update the worker's own note (the first message) and the summary/status,
    // but PRESERVE any later replies (e.g. an operator's) on the same thread.
    const messages =
      existing.messages.length > 0
        ? [
            { ...existing.messages[0]!, body: input.body, createdAt: input.createdAt },
            ...existing.messages.slice(1)
          ]
        : [message]
    return {
      ...plan,
      annotations: plan.annotations.map((candidate) =>
        candidate.id === input.id
          ? { ...candidate, body: input.body, status: input.status, messages }
          : candidate
      )
    }
  }
  const annotation: PlanAnnotation = {
    id: input.id,
    stageId: input.stageId,
    body: input.body,
    author: "agent",
    createdAt: input.createdAt,
    messages: [message],
    status: input.status
  }
  return { ...plan, annotations: [...plan.annotations, annotation] }
}

export const resolveWorkerAnnotation = (plan: PlanPrd, id: string): PlanPrd =>
  setAnnotationStatus(plan, id, "resolved") ?? plan
