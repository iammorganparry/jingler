import { Option, Schema } from "effect"
import { CliKind } from "./cli.js"
import type { Plan } from "./conversation.js"
import type { ReasoningEffort, ReasoningSetting } from "./domain.js"

/**
 * Jingler's plan document is a fully structured DTO — an Effect `Schema` the
 * agent emits directly (as a fenced JSON block) rather than HTML we parse.
 *
 * Prose, file lists, and diagrams are typed blocks (`PlanBlock`), not opaque
 * markup, so there is no HTML dialect, no sanitizer, and no derivation step: the
 * document IS the projection. The renderer maps each block/stage/acceptance to a
 * maintained React component (the "generative-UI map"). Plan documents never
 * carry scripts, styles, or arbitrary component code.
 */

export const PlanAcceptanceStatus = Schema.Literal("pending", "passed", "failed", "waived")
export type PlanAcceptanceStatus = Schema.Schema.Type<typeof PlanAcceptanceStatus>

/** One concrete repository test location and the named cases that prove a criterion. */
export const PlanTestReference = Schema.Struct({
  path: Schema.String,
  cases: Schema.Array(Schema.String)
})
export type PlanTestReference = Schema.Schema.Type<typeof PlanTestReference>

export const PlanAcceptance = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  /** Missing on legacy plans; decoded to an empty list for safe consumers. */
  testReferences: Schema.optionalToOptional(
    Schema.Array(PlanTestReference),
    Schema.Array(PlanTestReference),
    {
      decode: (references) => references.pipe(Option.orElse(() => Option.some([]))),
      encode: (references) => references
    }
  ),
  status: PlanAcceptanceStatus,
  evidence: Schema.NullOr(Schema.String)
})
export type PlanAcceptance = Schema.Schema.Type<typeof PlanAcceptance>

/** Durable progress for a planner-authored implementation task. */
export const PlanTaskStatus = Schema.Literal("pending", "in-progress", "completed", "blocked")
export type PlanTaskStatus = Schema.Schema.Type<typeof PlanTaskStatus>

export const PlanTask = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: PlanTaskStatus
})
export type PlanTask = Schema.Schema.Type<typeof PlanTask>

/**
 * A W3C-style TextQuote anchor: the exact `quote` plus a little `prefix`/`suffix`
 * context, scoped to a single block. Quote-based anchoring is used instead of raw
 * positions because a block's text is edited over time, where numeric offsets
 * drift but a quoted span with context can be re-found (or flagged orphaned when
 * the text it quoted no longer exists). `blockId` scopes resolution to one block's
 * text projection so context never spans component boundaries. See
 * `plan-anchor.ts`.
 */
export const PlanAnnotationAnchor = Schema.Struct({
  /** The block whose text projection this anchor resolves against. */
  blockId: Schema.optional(Schema.String),
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

/**
 * A file touched by a stage. Structured so the renderer draws a real file chip
 * (open + live diff stats) instead of parsing `<ul data-files>` HTML. Diff stats
 * are optional — a pre-execution plan estimates files it will touch.
 */
export const PlanFile = Schema.Struct({
  path: Schema.String,
  /** Added / Modified / Deleted. */
  change: Schema.Literal("A", "M", "D"),
  added: Schema.optional(Schema.Number),
  removed: Schema.optional(Schema.Number)
})
export type PlanFile = Schema.Schema.Type<typeof PlanFile>

/** A structured, embeddable flow diagram. Rendered live by the mermaid component. */
export const PlanDiagram = Schema.Struct({
  id: Schema.String,
  source: Schema.String
})
export type PlanDiagram = Schema.Schema.Type<typeof PlanDiagram>

/**
 * A prose block. `kind` is the discriminant the renderer's generative-UI map
 * keys on. Inline formatting inside `text`/list items/cells is a constrained
 * markdown subset (bold, italic, inline code, links) rendered safely — never
 * block-level HTML.
 */
export const PlanProseBlock = Schema.Struct({
  kind: Schema.Literal("prose"),
  id: Schema.String,
  text: Schema.String
})
export const PlanHeadingBlock = Schema.Struct({
  kind: Schema.Literal("heading"),
  id: Schema.String,
  level: Schema.Literal(2, 3, 4),
  text: Schema.String
})
export const PlanListBlock = Schema.Struct({
  kind: Schema.Literal("list"),
  id: Schema.String,
  ordered: Schema.Boolean,
  items: Schema.Array(Schema.String)
})
export const PlanCodeBlock = Schema.Struct({
  kind: Schema.Literal("code"),
  id: Schema.String,
  language: Schema.optional(Schema.String),
  code: Schema.String
})
export const PlanTableBlock = Schema.Struct({
  kind: Schema.Literal("table"),
  id: Schema.String,
  headers: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String))
})
export const PlanDiagramBlock = Schema.Struct({
  kind: Schema.Literal("diagram"),
  id: Schema.String,
  source: Schema.String
})

/**
 * A structured content block. This union IS the generative-UI contract: each
 * `kind` maps to a maintained React component in `packages/ui`. New widget kinds
 * are added here and in the registry together.
 */
export const PlanBlock = Schema.Union(
  PlanProseBlock,
  PlanHeadingBlock,
  PlanListBlock,
  PlanCodeBlock,
  PlanTableBlock,
  PlanDiagramBlock
)
export type PlanBlock = Schema.Schema.Type<typeof PlanBlock>

export const PlanPrdSection = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  blocks: Schema.Array(PlanBlock)
})
export type PlanPrdSection = Schema.Schema.Type<typeof PlanPrdSection>

/** Planner-owned estimate used to choose an appropriate worker model. */
export const PlanStageComplexity = Schema.Literal("low", "medium", "high")
export type PlanStageComplexity = Schema.Schema.Type<typeof PlanStageComplexity>

/** Worker routes use the same provider schema as sessions and discovery. */
export const PlanWorkerCli = CliKind
export type PlanWorkerCli = Schema.Schema.Type<typeof PlanWorkerCli>

// Kept structurally identical to the shared session setting without importing
// its runtime schema: `domain.ts` owns WorkspaceConfig and therefore already
// imports this module for WorkerRoutingConfig.
const WorkerReasoningSetting: Schema.Schema<ReasoningSetting> = Schema.Struct({
  enabled: Schema.Boolean,
  effort: Schema.optional(
    Schema.Literal("minimal", "low", "medium", "high", "xhigh", "max")
  )
})

export interface ProviderReasoningCapabilities {
  /** Whether the harness accepts an explicit on/off thinking setting. */
  readonly explicitToggle: boolean
  /** Provider-native effort values in display order. */
  readonly efforts: ReadonlyArray<ReasoningEffort>
}

const CODEX_REASONING_CAPABILITIES: ProviderReasoningCapabilities = {
  explicitToggle: true,
  efforts: ["minimal", "low", "medium", "high", "xhigh"]
}

/**
 * Provider reasoning capabilities shared by config validation and every UI that
 * offers reasoning controls. Undefined uses the Codex-compatible default that
 * session controls historically show before a harness is selected.
 */
export const providerReasoningCapabilitiesFor = (
  cli: PlanWorkerCli | undefined
): ProviderReasoningCapabilities => {
  switch (cli) {
    case "claude":
      return {
        explicitToggle: true,
        efforts: ["low", "medium", "high", "xhigh", "max"]
      }
    case "cursor":
      return { explicitToggle: false, efforts: [] }
    case "codex":
    case "opencode":
    case undefined:
      return CODEX_REASONING_CAPABILITIES
  }
}

/** Explain why an explicit reasoning setting cannot be sent to a harness. */
export const workerReasoningSettingIssue = (
  cli: PlanWorkerCli,
  reasoning: ReasoningSetting | undefined
): string | null => {
  if (reasoning === undefined) return null
  if (!reasoning.enabled && reasoning.effort !== undefined) {
    return "disabled thinking cannot also select a reasoning effort"
  }
  const capabilities = providerReasoningCapabilitiesFor(cli)
  if (!capabilities.explicitToggle) {
    return "Cursor does not support an explicit reasoning setting"
  }
  if (reasoning.effort === undefined) return null
  return capabilities.efforts.includes(reasoning.effort)
    ? null
    : `${cli} does not support reasoning effort "${reasoning.effort}"`
}

/** One concrete provider/model target selected by the worker router. */
export const WorkerModelRoute = Schema.Struct({
  cli: PlanWorkerCli,
  model: Schema.String,
  /** Absent means use the selected provider/model's own reasoning default. */
  reasoning: Schema.optional(WorkerReasoningSetting)
}).pipe(
  Schema.filter(
    (route) =>
      workerReasoningSettingIssue(route.cli, route.reasoning) ?? true
  )
)
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
  reason: Schema.String,
  /** Absent on legacy plans and interpreted as the provider/model default. */
  reasoning: Schema.optional(WorkerReasoningSetting)
}).pipe(
  Schema.filter(
    (assignment) =>
      workerReasoningSettingIssue(assignment.cli, assignment.reasoning) ?? true
  )
)
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
  /** One-line summary of what the stage does. */
  intent: Schema.String,
  /** Ordered approach steps (was the stage's `<h3>Approach</h3>` list). */
  approach: Schema.Array(Schema.String),
  /** Missing on legacy plans; decoded to an empty list for safe consumers. */
  tasks: Schema.optionalToOptional(Schema.Array(PlanTask), Schema.Array(PlanTask), {
    decode: (tasks) => tasks.pipe(Option.orElse(() => Option.some([]))),
    encode: (tasks) => tasks
  }),
  /** Repository-relative files the stage touches, with change kind + diff stats. */
  files: Schema.Array(PlanFile),
  /** Embedded flow diagrams. */
  diagrams: Schema.Array(PlanDiagram),
  /** Any remaining rich prose for the stage body. */
  notes: Schema.Array(PlanBlock),
  acceptance: Schema.Array(PlanAcceptance),
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

/** A blank plan for a fresh user draft (replaces DEFAULT_PLAN_TEMPLATE_HTML). */
export const defaultPlan = (title = "Plan"): PlanPrd => ({
  title,
  sections: [],
  stages: [],
  annotations: []
})

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
 * The structured plan IS the document — `plan` is authoritative and crosses RPC
 * as-is; there is no HTML source to parse and no derived projection to keep in
 * sync.
 */
export const PlanDocument = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  producingChatId: Schema.String,
  revision: Schema.Number,
  status: PlanDocumentStatus,
  plan: PlanPrd,
  updatedAt: Schema.String,
  updatedBy: PlanDocumentAuthor
})
export type PlanDocument = Schema.Schema.Type<typeof PlanDocument>

/**
 * A user-configured starting plan. `source` is a JSON-serialized `PlanPrd`
 * (formerly HTML); an empty string means "use the built-in blank draft".
 */
export const PlanTemplateConfig = Schema.Struct({
  source: Schema.String
})
export type PlanTemplateConfig = Schema.Schema.Type<typeof PlanTemplateConfig>

/** The plain text of one block — the substrate comment anchors resolve against. */
export const planBlockText = (block: PlanBlock): string => {
  switch (block.kind) {
    case "prose":
    case "heading":
      return block.text
    case "list":
      return block.items.join("\n")
    case "code":
      return block.code
    case "table":
      return [block.headers, ...block.rows].map((row) => row.join(" │ ")).join("\n")
    case "diagram":
      return ""
  }
}

/**
 * A deterministic plain-text rendering of a plan, in document order. Comment
 * anchoring resolves against this (per block) instead of rendered DOM text, so
 * offsets never depend on component chrome or layout.
 */
export const planTextProjection = (plan: PlanPrd): string => {
  const parts: Array<string> = [plan.title]
  for (const section of plan.sections) {
    parts.push(section.title)
    for (const block of section.blocks) parts.push(planBlockText(block))
  }
  for (const stage of plan.stages) {
    parts.push(stage.title, stage.intent)
    for (const step of stage.approach) parts.push(step)
    for (const task of stage.tasks ?? []) parts.push(task.text)
    for (const block of stage.notes) parts.push(planBlockText(block))
    for (const criterion of stage.acceptance) parts.push(criterion.text)
  }
  return parts.filter((part) => part.length > 0).join("\n\n")
}

/**
 * Compatibility projection for transcript cards, derived from the structured
 * plan whenever an older `Plan` consumer needs to render the current document.
 * `raw` carries a plain-text projection of the plan so legacy markdown renderers
 * still show something meaningful.
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
    summary: document.plan.title.replace(/^PRD:\s*/i, ""),
    steps: document.plan.stages.map((stage, index) => {
      const complete = stage.acceptance.every(
        (criterion) => criterion.status === "passed" || criterion.status === "waived"
      )
      return {
        id: stage.id,
        number: String(index + 1).padStart(2, "0"),
        title: stage.title,
        intent: stage.intent,
        approach: [...stage.approach],
        kind: "step",
        condition: null,
        parentId: null,
        dependsOn: stage.dependencies ?? [],
        blocks: [],
        files: stage.files.map((file) => ({
          change: file.change,
          path: file.path,
          added: file.added ?? 0,
          removed: file.removed ?? 0
        })),
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
          document.plan.annotations.some(
            (annotation) => annotation.stageId === stage.id && annotation.status === "open"
          )
      }
    }),
    comments: document.plan.annotations.map((annotation) => {
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
    raw: planTextProjection(document.plan)
  }
}
