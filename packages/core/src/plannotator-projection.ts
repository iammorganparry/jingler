import { Schema } from "effect"
import type { PlanBlock, PlanDocument, PlanDocumentStatus } from "./plan-document.js"

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
  /** Legacy browser-review URL; the native review surface has none. */
  url: Schema.optional(Schema.String)
})
export type PlannotatorReview = Schema.Schema.Type<typeof PlannotatorReview>

/**
 * Operator verdict on a pending Plannotator review, emitted by the host onto
 * the session's event bus. Matched to the review by id: stale or duplicate
 * decisions are ignored by the extension.
 */
export const PlannotatorReviewDecision = Schema.Struct({
  reviewId: Schema.String,
  approved: Schema.Boolean,
  feedback: Schema.optional(Schema.String)
})
export type PlannotatorReviewDecision = Schema.Schema.Type<
  typeof PlannotatorReviewDecision
>

export const PlannotatorTaskStatus = Schema.Literal(
  "pending",
  "in-progress",
  "completed",
  "blocked"
)
export type PlannotatorTaskStatus = Schema.Schema.Type<typeof PlannotatorTaskStatus>

const stageTaskFields = {
  /** 1-based position in the FLAT checklist — the [DONE:n] number. */
  step: Schema.Number,
  text: Schema.String,
  status: PlannotatorTaskStatus
}
export const PlannotatorStageSubtask = Schema.Struct(stageTaskFields)
export type PlannotatorStageSubtask = Schema.Schema.Type<typeof PlannotatorStageSubtask>
export const PlannotatorStageTask = Schema.Struct({
  ...stageTaskFields,
  subtasks: Schema.optionalWith(Schema.Array(PlannotatorStageSubtask), {
    default: () => []
  })
})
export type PlannotatorStageTask = Schema.Schema.Type<typeof PlannotatorStageTask>

export const PlannotatorAcceptanceItem = Schema.Struct({
  step: Schema.Number,
  text: Schema.String,
  status: Schema.Literal("pending", "passed"),
  testReferences: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, cases: Schema.Array(Schema.String) }))
  )
})
export type PlannotatorAcceptanceItem = Schema.Schema.Type<typeof PlannotatorAcceptanceItem>

export const PlannotatorStage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  intent: Schema.optionalWith(Schema.String, { default: () => "" }),
  approach: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  tasks: Schema.optionalWith(Schema.Array(PlannotatorStageTask), { default: () => [] }),
  acceptance: Schema.optionalWith(Schema.Array(PlannotatorAcceptanceItem), {
    default: () => []
  }),
  files: Schema.optionalWith(
    Schema.Array(Schema.Struct({ path: Schema.String, change: Schema.Literal("A", "M", "D") })),
    { default: () => [] }
  ),
  diagrams: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  notes: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  complexity: Schema.optional(Schema.Literal("low", "medium", "high")),
  dependencies: Schema.optional(Schema.Array(Schema.String))
})
export type PlannotatorStage = Schema.Schema.Type<typeof PlannotatorStage>

export const PlannotatorSectionBlock = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("prose"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("heading"),
    level: Schema.Literal(2, 3, 4),
    text: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    ordered: Schema.Boolean,
    items: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("code"),
    language: Schema.optional(Schema.String),
    code: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("diagram"), source: Schema.String })
)
export type PlannotatorSectionBlock = Schema.Schema.Type<typeof PlannotatorSectionBlock>

export const PlannotatorSection = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  blocks: Schema.Array(PlannotatorSectionBlock)
})
export type PlannotatorSection = Schema.Schema.Type<typeof PlannotatorSection>

export const PlannotatorProjection = Schema.Struct({
  phase: Schema.Literal("idle", "planning", "executing"),
  planFilePath: Schema.NullOr(Schema.String),
  review: Schema.NullOr(PlannotatorReview),
  checklist: Schema.Array(PlannotatorChecklistItem),
  /** Structured plan payload — absent from flat/legacy publishers. */
  title: Schema.optional(Schema.NullOr(Schema.String)),
  revision: Schema.optional(Schema.Number),
  stages: Schema.optional(Schema.Array(PlannotatorStage)),
  sections: Schema.optional(Schema.Array(PlannotatorSection))
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

/**
 * Projection → the canonical read-only `PlanDocument`.
 *
 * Structured publishers (the forked extension parsing the markdown scratchpad)
 * supply `stages`/`sections` and map losslessly; flat/legacy payloads fall back
 * to one stage per checklist item, exactly as before. This stays the SINGLE
 * translation point into the DTO — the UI never interprets host-state itself.
 */
export const plannotatorProjectionToPlanDocument = (
  projection: PlannotatorProjection,
  sessionId: string,
  producingChatId: string,
  updatedAt: string
): PlanDocument => ({
  id: `plannotator:${projection.planFilePath ?? "plan"}`,
  sessionId,
  producingChatId,
  revision: projection.revision ?? 1,
  ...(projection.review === null ? {} : { reviewId: projection.review.reviewId }),
  status: projectionStatus(projection),
  plan: {
    title: projection.title ?? projection.planFilePath ?? "Plan",
    sections: (projection.sections ?? []).map((section, index) => ({
      id: `plannotator-section-${index + 1}`,
      title: section.title ?? "",
      blocks: section.blocks.map((block, blockIndex) =>
        sectionBlockToPlanBlock(block, `plannotator-section-${index + 1}-block-${blockIndex + 1}`)
      )
    })),
    stages: (projection.stages ?? []).length > 0
      ? (projection.stages ?? []).map((stage) => structuredStageToPlanStage(stage))
      : projection.checklist.map((item) => flatStageOf(item)),
    annotations: []
  },
  updatedAt,
  updatedBy: "agent"
})

const sectionBlockToPlanBlock = (
  block: PlannotatorSectionBlock,
  id: string
): PlanBlock => {
  switch (block.kind) {
    case "prose":
      return { kind: "prose", id, text: block.text }
    case "heading":
      return { kind: "heading", id, level: block.level, text: block.text }
    case "list":
      return { kind: "list", id, ordered: block.ordered, items: block.items }
    case "code":
      return {
        kind: "code",
        id,
        ...(block.language === undefined ? {} : { language: block.language }),
        code: block.code
      }
    case "diagram":
      return { kind: "diagram", id, source: block.source }
  }
}

const structuredStageToPlanStage = (
  stage: PlannotatorStage
): PlanDocument["plan"]["stages"][number] => ({
  id: stage.id,
  title: stage.title,
  intent: stage.intent,
  approach: stage.approach,
  tasks: stage.tasks.flatMap((task) => [
    {
      id: `plannotator-task-${task.step}`,
      text: task.text,
      status: task.status
    },
    ...task.subtasks.map((subtask) => ({
      id: `plannotator-task-${subtask.step}`,
      text: subtask.text,
      status: subtask.status
    }))
  ]),
  files: stage.files.map((file) => ({ path: file.path, change: file.change })),
  diagrams: stage.diagrams.map((source, index) => ({
    id: `${stage.id}-diagram-${index + 1}`,
    source
  })),
  notes: stage.notes.map((text, index) => ({
    kind: "prose" as const,
    id: `${stage.id}-note-${index + 1}`,
    text
  })),
  acceptance: stage.acceptance.map((criterion) => ({
    id: `plannotator-acceptance-${criterion.step}`,
    text: criterion.text,
    status: criterion.status,
    evidence: null,
    ...(criterion.testReferences === undefined
      ? {}
      : {
          testReferences: criterion.testReferences.map((reference) => ({
            path: reference.path,
            cases: reference.cases
          }))
        })
  })),
  ...(stage.complexity === undefined ? {} : { complexity: stage.complexity }),
  ...(stage.dependencies === undefined ? {} : { dependencies: stage.dependencies })
})

const flatStageOf = (
  item: PlannotatorChecklistItem
): PlanDocument["plan"]["stages"][number] => ({
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
})
