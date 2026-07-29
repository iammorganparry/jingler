import { Schema } from "effect"
import type { Plan } from "./conversation.js"

/**
 * Jingler's plan document is a deliberately small MDX dialect.
 *
 * Markdown carries prose. `Stage`, `Acceptance`, and `Annotation` are data-only
 * elements parsed by Jingler and rendered through a fixed React registry. Plan
 * documents never execute expressions, imports, exports, or arbitrary component
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

export const PlanAnnotation = Schema.Struct({
  id: Schema.String,
  stageId: Schema.NullOr(Schema.String),
  body: Schema.String,
  author: Schema.Literal("user", "agent"),
  status: Schema.Literal("open", "resolved"),
  createdAt: Schema.String,
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

export const PlanPrdStage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  intent: Schema.String,
  markdown: Schema.String,
  acceptance: Schema.Array(PlanAcceptance)
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
 * write and crosses RPC so the renderer never needs an MDX compiler.
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

const markdownSection = (markdown: string, title: string): string => {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return (
    new RegExp(`(?:^|\\n)###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, "i")
      .exec(markdown)?.[1]
      ?.trim() ?? ""
  )
}

const stageFiles = (markdown: string): Plan["steps"][number]["files"] =>
  [
    ...markdownSection(markdown, "Files").matchAll(
      /^\s*-\s*([AMD])\s+`([^`]+)`\s+\(\+(\d+)\s+[−-](\d+)\)\s*$/gm
    )
  ].map((match) => ({
    change: match[1] as "A" | "M" | "D",
    path: match[2]!,
    added: Number(match[3]),
    removed: Number(match[4])
  }))

/**
 * Compatibility projection for transcript cards. The MDX source remains
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
      const approach = markdownSection(stage.markdown, "Approach")
        .split(/\n+/)
        .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
        .filter(Boolean)
      return {
        id: stage.id,
        number: String(index + 1).padStart(2, "0"),
        title: stage.title,
        intent: stage.intent,
        approach,
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: [],
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
    comments: document.projection.annotations.map((annotation) => ({
      id: annotation.id,
      stepId: annotation.stageId ?? "",
      body: annotation.body,
      author: annotation.author,
      createdAt: annotation.createdAt,
      routed: annotation.status === "resolved"
    })),
    status,
    structured: true,
    raw: document.source
  }
}

