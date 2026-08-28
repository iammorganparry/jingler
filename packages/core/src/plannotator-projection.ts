import { Schema } from "effect"
import type { PlanDocument, PlanDocumentStatus } from "./plan-document.js"

export const PlannotatorChecklistItem = Schema.Struct({
  step: Schema.Number,
  text: Schema.String,
  completed: Schema.Boolean
})
export type PlannotatorChecklistItem = Schema.Schema.Type<
  typeof PlannotatorChecklistItem
>

export const PlannotatorReview = Schema.Struct({
  reviewId: Schema.String,
  url: Schema.String
})
export type PlannotatorReview = Schema.Schema.Type<typeof PlannotatorReview>

export const PlannotatorProjection = Schema.Struct({
  phase: Schema.Literal("idle", "planning", "executing"),
  planFilePath: Schema.NullOr(Schema.String),
  review: Schema.NullOr(PlannotatorReview),
  checklist: Schema.Array(PlannotatorChecklistItem)
})
export type PlannotatorProjection = Schema.Schema.Type<typeof PlannotatorProjection>

const projectionStatus = (
  projection: PlannotatorProjection
): PlanDocumentStatus => {
  if (projection.review !== null) return "proposed"
  if (projection.phase === "planning") return "draft"
  if (projection.phase === "executing") return "executing"
  return projection.checklist.length > 0 && projection.checklist.every(({ completed }) => completed)
    ? "done"
    : "draft"
}

/** Compatibility DTO for Jingler's existing read-only task components. */
export const plannotatorProjectionToPlanDocument = (
  projection: PlannotatorProjection,
  sessionId: string,
  producingChatId: string,
  updatedAt: string
): PlanDocument => ({
  id: `plannotator:${projection.planFilePath ?? "plan"}`,
  sessionId,
  producingChatId,
  revision: 1,
  status: projectionStatus(projection),
  plan: {
    title: projection.planFilePath ?? "Plan",
    sections: [],
    stages: projection.checklist.map((item) => ({
      id: `plannotator-step-${item.step}`,
      title: item.text,
      intent: item.text,
      approach: [],
      tasks: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{
        id: `plannotator-step-${item.step}-done`,
        text: item.text,
        status: item.completed ? "passed" : "pending",
        evidence: null
      }]
    })),
    annotations: []
  },
  updatedAt,
  updatedBy: "agent"
})
