import { Schema } from "effect"
import { parse } from "node-html-parser"
import { CliKind } from "./cli.js"
import type { Plan } from "./conversation.js"

/**
 * Jingler's plan document is a deliberately small HTML dialect.
 *
 * Ordinary HTML carries prose. `data-stage`, `data-acceptance`, and
 * `data-annotation` attributes carry structure through a fixed parser and Tiptap
 * schema. Plan documents never execute scripts, styles, or arbitrary component
 * code.
 */

export const PlanAcceptanceStatus = Schema.Literal("pending", "passed", "failed", "waived")
export type PlanAcceptanceStatus = Schema.Schema.Type<typeof PlanAcceptanceStatus>

export const PlanAcceptance = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: PlanAcceptanceStatus,
  evidence: Schema.NullOr(Schema.String)
})
export type PlanAcceptance = Schema.Schema.Type<typeof PlanAcceptance>

/**
 * A W3C-style TextQuote anchor: the exact `quote` plus a little `prefix`/`suffix`
 * context. Quote-based anchoring is used instead of raw ProseMirror positions
 * because plan source is edited and round-tripped through markdown, where numeric
 * offsets drift but a quoted span with context can be re-found (or flagged
 * orphaned when the text it quoted no longer exists). See `plan-anchor.ts`.
 */
export const PlanAnnotationAnchor = Schema.Struct({
  quote: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String
})
export type PlanAnnotationAnchor = Schema.Schema.Type<typeof PlanAnnotationAnchor>

export const PlanCommentMessageDeliveryState = Schema.Literal("pending", "sent", "failed")
export type PlanCommentMessageDeliveryState = Schema.Schema.Type<
  typeof PlanCommentMessageDeliveryState
>

export const PlanCommentMentionDeliveryStatus = Schema.Literal(
  "pending",
  "dispatching",
  "delivered",
  "unavailable",
  "failed"
)
export type PlanCommentMentionDeliveryStatus = Schema.Schema.Type<
  typeof PlanCommentMentionDeliveryStatus
>

/** Durable per-recipient outbox state for one mentioned participant. */
export const PlanCommentMentionDelivery = Schema.Struct({
  participantId: Schema.String,
  status: PlanCommentMentionDeliveryStatus,
  dispatchId: Schema.String,
  detail: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean
})
export type PlanCommentMentionDelivery = Schema.Schema.Type<
  typeof PlanCommentMentionDelivery
>

/**
 * One durable entry in a plan annotation thread. `authorId` is deliberately
 * separate from `authorKind`: a worker and the coordinating agent are both
 * agents, but remain addressable participants for replies and mentions.
 */
export const PlanCommentMessage = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  authorKind: Schema.Literal("user", "agent"),
  authorId: Schema.String,
  createdAt: Schema.String,
  mentionedParticipantIds: Schema.Array(Schema.String),
  deliveryState: PlanCommentMessageDeliveryState,
  /** Optional only for backward compatibility with plans written before the outbox. */
  mentionDeliveries: Schema.optional(Schema.Array(PlanCommentMentionDelivery))
})
export type PlanCommentMessage = Schema.Schema.Type<typeof PlanCommentMessage>

export const PlanAnnotation = Schema.Struct({
  id: Schema.String,
  stageId: Schema.NullOr(Schema.String),
  /**
   * Compatibility summary of the thread's first message. New code should use
   * `messages`; keeping these fields avoids breaking legacy plan-card clients.
   */
  body: Schema.String,
  author: Schema.Literal("user", "agent"),
  createdAt: Schema.String,
  messages: Schema.Array(PlanCommentMessage),
  status: Schema.Literal("open", "resolved"),
  /** Present when the comment is anchored to a highlighted span (vs. a whole stage). */
  anchor: Schema.optional(PlanAnnotationAnchor)
})
export type PlanAnnotation = Schema.Schema.Type<typeof PlanAnnotation>

export const PlanPrdSection = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  markdown: Schema.String
})
export type PlanPrdSection = Schema.Schema.Type<typeof PlanPrdSection>

/** Planner-owned estimate used to choose an appropriate worker model. */
export const PlanStageComplexity = Schema.Literal("low", "medium", "high")
export type PlanStageComplexity = Schema.Schema.Type<typeof PlanStageComplexity>

/** Worker routes use the same provider schema as sessions and discovery. */
export const PlanWorkerCli = CliKind
export type PlanWorkerCli = Schema.Schema.Type<typeof PlanWorkerCli>

/** One concrete provider/model target selected by the worker router. */
export const WorkerModelRoute = Schema.Struct({
  cli: PlanWorkerCli,
  model: Schema.String
})
export type WorkerModelRoute = Schema.Schema.Type<typeof WorkerModelRoute>

/**
 * Complexity router for implementation workers. `default` is the durable
 * fallback for unavailable or unclassified work; explicit buckets let the
 * operator trade capability and cost without changing the orchestrator model.
 */
export const WorkerRoutingConfig = Schema.Struct({
  default: WorkerModelRoute,
  low: WorkerModelRoute,
  medium: WorkerModelRoute,
  high: WorkerModelRoute
})
export type WorkerRoutingConfig = Schema.Schema.Type<typeof WorkerRoutingConfig>

/** Provider-neutral route selected by the orchestrator for one logical worker. */
export const PlanStageAssignment = Schema.Struct({
  agentId: Schema.String,
  cli: PlanWorkerCli,
  model: Schema.String,
  reason: Schema.String
})
export type PlanStageAssignment = Schema.Schema.Type<typeof PlanStageAssignment>

/** Durable state written by the orchestration service as a worker progresses. */
export const PlanStageExecutionStatus = Schema.Literal(
  "queued",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "completed"
)
export type PlanStageExecutionStatus = Schema.Schema.Type<typeof PlanStageExecutionStatus>

export const PlanPrdStage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  intent: Schema.String,
  markdown: Schema.String,
  acceptance: Schema.Array(PlanAcceptance),
  /** Optional at the persistence boundary so projections written before orchestration still decode. */
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  complexity: Schema.optional(PlanStageComplexity),
  assignment: Schema.optional(Schema.NullOr(PlanStageAssignment)),
  executionStatus: Schema.optional(PlanStageExecutionStatus)
})
export type PlanPrdStage = Schema.Schema.Type<typeof PlanPrdStage>

export const PlanPrd = Schema.Struct({
  title: Schema.String,
  sections: Schema.Array(PlanPrdSection),
  stages: Schema.Array(PlanPrdStage),
  annotations: Schema.Array(PlanAnnotation)
})
export type PlanPrd = Schema.Schema.Type<typeof PlanPrd>

export const PlanDocumentStatus = Schema.Literal(
  "draft",
  "proposed",
  "revising",
  "approved",
  "executing",
  "needs-verification",
  "done",
  "rejected",
  "stale"
)
export type PlanDocumentStatus = Schema.Schema.Type<typeof PlanDocumentStatus>

export const PlanDocumentAuthor = Schema.Literal("agent", "user")
export type PlanDocumentAuthor = Schema.Schema.Type<typeof PlanDocumentAuthor>

/** Outcome of approving a live parked plan without weakening revision guards. */
export const PlanApprovalResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("accepted")
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    message: Schema.String,
    latestRevision: Schema.Number
  })
)
export type PlanApprovalResult = Schema.Schema.Type<typeof PlanApprovalResult>

/**
 * `source` is authoritative. `projection` is derived from it on every accepted
 * write and crosses RPC so the renderer never needs to parse the source itself.
 */
export const PlanDocument = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  producingChatId: Schema.String,
  revision: Schema.Number,
  status: PlanDocumentStatus,
  source: Schema.String,
  projection: PlanPrd,
  updatedAt: Schema.String,
  updatedBy: PlanDocumentAuthor
})
export type PlanDocument = Schema.Schema.Type<typeof PlanDocument>

export const PlanTemplateConfig = Schema.Struct({
  source: Schema.String
})
export type PlanTemplateConfig = Schema.Schema.Type<typeof PlanTemplateConfig>

const CHANGES = new Set(["A", "M", "D"])

/** The `<li>` texts under a stage's `<h3>Approach</h3>` heading's following list. */
const stageApproach = (html: string): ReadonlyArray<string> => {
  const heading = parse(html)
    .querySelectorAll("h3")
    .find((h) => /approach/i.test(h.text))
  const list = heading?.nextElementSibling
  const tag = list?.rawTagName?.toLowerCase()
  if (list == null || (tag !== "ol" && tag !== "ul")) return []
  return list.querySelectorAll("li").map((li) => li.text.trim()).filter((t) => t.length > 0)
}

/** Parse `<ul data-files><li data-change data-added data-removed>path</li></ul>`. */
const stageFiles = (html: string): Plan["steps"][number]["files"] => {
  const list = parse(html).querySelector("ul[data-files]")
  if (list === null) return []
  return list.querySelectorAll("li").map((li) => {
    const change = (li.getAttribute("data-change") ?? "M").toUpperCase()
    return {
      change: (CHANGES.has(change) ? change : "M") as "A" | "M" | "D",
      path: li.text.trim(),
      added: Number(li.getAttribute("data-added") ?? "0") || 0,
      removed: Number(li.getAttribute("data-removed") ?? "0") || 0
    }
  })
}

/**
 * Compatibility projection for transcript cards. The HTML source remains
 * authoritative; this shape is derived whenever an older Plan consumer needs
 * to render the current document.
 */
export const planDocumentToPlan = (document: PlanDocument): Plan => {
  const status: Plan["status"] =
    document.status === "revising"
      ? "revising"
      : document.status === "rejected"
        ? "rejected"
        : document.status === "stale"
          ? "stale"
          : document.status === "approved" ||
              document.status === "executing" ||
              document.status === "needs-verification" ||
              document.status === "done"
            ? "approved"
            : "proposed"

  return {
    id: document.id,
    summary: document.projection.title.replace(/^PRD:\s*/i, ""),
    steps: document.projection.stages.map((stage, index) => {
      const complete = stage.acceptance.every(
        (criterion) => criterion.status === "passed" || criterion.status === "waived"
      )
      const approach = stageApproach(stage.markdown)
      return {
        id: stage.id,
        number: String(index + 1).padStart(2, "0"),
        title: stage.title,
        intent: stage.intent,
        approach,
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: stage.dependencies ?? [],
        blocks: [],
        files: stageFiles(stage.markdown),
        guards: stage.acceptance.map((criterion) => ({
          text: criterion.text,
          status:
            criterion.status === "passed"
              ? "ok"
              : criterion.status === "failed"
                ? "warn"
                : criterion.status === "waived"
                  ? "under-review"
                  : "open"
        })),
        code: null,
        graph: null,
        diff: null,
        status: complete
          ? "done"
          : document.status === "revising"
            ? "revising"
            : document.status === "executing" || document.status === "needs-verification"
              ? "current"
              : "proposed",
        flagged:
          stage.acceptance.some((criterion) => criterion.status === "failed") ||
          document.projection.annotations.some(
            (annotation) => annotation.stageId === stage.id && annotation.status === "open"
          )
      }
    }),
    comments: document.projection.annotations.map((annotation) => {
      const message = annotation.messages.at(-1)
      return {
        id: annotation.id,
        stepId: annotation.stageId ?? "",
        body: message?.body ?? annotation.body,
        author: message?.authorKind ?? annotation.author,
        createdAt: message?.createdAt ?? annotation.createdAt,
        routed: annotation.status === "resolved"
      }
    }),
    status,
    structured: true,
    raw: document.source
  }
}
