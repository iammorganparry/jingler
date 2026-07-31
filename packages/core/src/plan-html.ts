import { type HTMLElement, NodeType, parse } from "node-html-parser"
import { CLI_KINDS } from "./cli.js"
import type {
  PlanAcceptance,
  PlanAcceptanceStatus,
  PlanAnnotation,
  PlanCommentMessage,
  PlanCommentMessageDeliveryState,
  PlanCommentMentionDelivery,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage,
  PlanStageAssignment,
  PlanStageComplexity,
  PlanStageExecutionStatus
} from "./plan-document.js"
import {
  buildPlanExecutionGraph,
  type PlanExecutionDiagnosticCode
} from "./plan-execution.js"

/**
 * Jingler plans are HTML documents rendered/edited in a Tiptap ("Notion-doc")
 * editor. This module is the HTML counterpart of the old MDX engine: it
 * sanitizes untrusted plan HTML down to a safe structural subset, and extracts
 * the machine-readable PlanPrd projection (title, sections, stages, acceptance
 * criteria, annotations) that drives approval, completion, and comments.
 *
 * ## The dialect
 *
 * Prose is ordinary HTML (headings, lists, tables, code, blockquotes). Structure
 * is carried on data-attributes so it round-trips losslessly through the Tiptap
 * schema and stays queryable server-side:
 *
 *   <h1>PRD: ...</h1>                                 the title
 *   <h2>Context</h2><p>...</p>                        a prose section (h2 + body)
 *   <div data-diagram="mermaid"><pre>graph TD...</pre> an embeddable flow diagram
 *   <section data-stage="01" data-title="..." data-depends-on="00"
 *            data-complexity="high">                  a stage
 *     <div data-assignment data-agent-id="worker-a" data-cli="codex"
 *          data-model="gpt-5" data-reason="..." data-status="queued"></div>
 *     <div data-acceptance="01.1" data-status="pending" data-evidence="...">...</div>
 *     <aside data-annotation="a1" data-stage="01" data-author="user"
 *            data-status="open" data-quote="..." data-prefix="..." data-suffix="...">
 *       <div data-comment-message="m1" data-author-kind="user"
 *            data-author-id="operator" data-created-at="..."
 *            data-mentioned-participant-ids='["worker-a"]'
 *            data-delivery-state="pending">...</div>
 *     </aside>
 *
 * ## Safety
 *
 * Plan HTML is attacker-influenceable (agents write it), so sanitizePlanHtml
 * strips everything outside an allowlist BEFORE the string is ever persisted or
 * handed to a renderer -- no <script>/<style>/<iframe>, no event handlers, no
 * inline styles, no javascript: URLs. The Tiptap schema drops unknown nodes on
 * top of this, but the authoritative guard is here, on the write path.
 */

export interface PlanHtmlDiagnostic {
  readonly code:
    | "empty"
    | "missing-title"
    | "missing-stage"
    | "missing-acceptance"
    | "duplicate-id"
    | "invalid-status"
    | "invalid-complexity"
    | "invalid-assignment"
    | "invalid-execution-status"
    | "invalid-comment-message"
    | "running-stage-removed"
    | PlanExecutionDiagnosticCode
  readonly message: string
}

export type PlanHtmlResult =
  | {
      readonly valid: true
      readonly projection: PlanPrd
      readonly html: string
      readonly diagnostics: readonly []
    }
  | {
      readonly valid: false
      readonly projection: null
      readonly html: string
      readonly diagnostics: ReadonlyArray<PlanHtmlDiagnostic>
    }

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
  "strong", "em", "b", "i", "u", "s", "code", "pre", "kbd", "mark",
  "blockquote", "ul", "ol", "li",
  "a", "table", "thead", "tbody", "tr", "td", "th",
  "section", "aside", "div", "span"
])

// Dropped node-and-subtree (never unwrapped -- their contents are unsafe too).
const DROP_SUBTREE = new Set([
  "script", "style", "iframe", "object", "embed", "noscript",
  "template", "form", "input", "button", "select", "textarea", "link", "meta"
])

const ALLOWED_ATTRS = new Set([
  "data-stage", "data-title", "data-acceptance", "data-status", "data-evidence",
  "data-annotation", "data-author", "data-created-at",
  "data-comment-message", "data-author-kind", "data-author-id",
  "data-mentioned-participant-ids", "data-delivery-state", "data-mention-deliveries",
  "data-quote", "data-prefix", "data-suffix", "data-diagram",
  "data-depends-on", "data-complexity", "data-assignment", "data-agent-id",
  "data-cli", "data-model", "data-reason", "data-execution-status",
  // Per-stage file linkage: <ul data-files><li data-change data-added data-removed>path</li></ul>.
  "data-files", "data-change", "data-added", "data-removed",
  "colspan", "rowspan"
])

const safeHref = (value: string): boolean => {
  const v = value.trim().toLowerCase()
  return !v.startsWith("javascript:") && !v.startsWith("data:") && !v.startsWith("vbscript:")
}

/** Recursively strip a parsed tree to the allowlisted subset (mutates in place). */
const scrub = (node: HTMLElement): void => {
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue
    const el = child as HTMLElement
    const tag = el.rawTagName?.toLowerCase() ?? ""
    if (DROP_SUBTREE.has(tag)) {
      el.remove()
      continue
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // Keep the content, drop the wrapper.
      scrub(el)
      el.replaceWith(...el.childNodes)
      continue
    }
    for (const name of Object.keys(el.attributes)) {
      const lower = name.toLowerCase()
      if (lower === "href" && tag === "a") {
        if (!safeHref(el.getAttribute("href") ?? "")) el.removeAttribute(name)
        continue
      }
      if (!ALLOWED_ATTRS.has(lower)) el.removeAttribute(name)
    }
    scrub(el)
  }
}

export const sanitizePlanHtml = (html: string): string => {
  const root = parse(html, { comment: false })
  scrub(root)
  return root.toString().trim()
}

const STATUSES: ReadonlyArray<PlanAcceptanceStatus> = ["pending", "passed", "failed", "waived"]
const MESSAGE_DELIVERY_STATES: ReadonlyArray<PlanCommentMessageDeliveryState> = [
  "pending",
  "sent",
  "failed"
]

const MENTION_DELIVERY_STATUSES = [
  "pending",
  "dispatching",
  "delivered",
  "unavailable",
  "failed"
] as const

const mentionDeliveryStatusFrom = (
  value: unknown
): PlanCommentMentionDelivery["status"] | undefined =>
  MENTION_DELIVERY_STATUSES.find((status) => status === value)

const mentionDeliveriesFrom = (
  el: HTMLElement,
  diagnostics: Array<PlanHtmlDiagnostic>,
  messageId: string
): ReadonlyArray<PlanCommentMentionDelivery> | undefined => {
  const raw = el.getAttribute("data-mention-deliveries")
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw.startsWith("[") ? raw : decodeURIComponent(raw))
    if (!Array.isArray(parsed)) throw new Error("deliveries must be an array")
    const deliveries = parsed.map((value) => {
      if (typeof value !== "object" || value === null) throw new Error("invalid delivery")
      if (!("participantId" in value) || !("dispatchId" in value) || !("status" in value)) {
        throw new Error("invalid delivery")
      }
      const status = mentionDeliveryStatusFrom(value.status)
      if (
        typeof value.participantId !== "string" ||
        typeof value.dispatchId !== "string" ||
        status === undefined ||
        !("detail" in value) ||
        (value.detail !== null && typeof value.detail !== "string") ||
        !("retryable" in value) ||
        typeof value.retryable !== "boolean"
      ) {
        throw new Error("invalid delivery")
      }
      return {
        participantId: value.participantId,
        status,
        dispatchId: value.dispatchId,
        detail: value.detail,
        retryable: value.retryable
      } satisfies PlanCommentMentionDelivery
    })
    return deliveries
  } catch {
    diagnostics.push({
      code: "invalid-comment-message",
      message: `Comment message "${messageId}" has invalid mention deliveries.`
    })
    return undefined
  }
}
const COMPLEXITIES: ReadonlyArray<PlanStageComplexity> = ["low", "medium", "high"]
const EXECUTION_STATUSES: ReadonlyArray<PlanStageExecutionStatus> = [
  "queued",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "completed"
]
const dependenciesFrom = (el: HTMLElement): ReadonlyArray<string> => [
  ...new Set(
    (el.getAttribute("data-depends-on") ?? "")
      .split(/[\s,]+/)
      .map((dependency) => dependency.trim())
      .filter((dependency) => dependency.length > 0)
  )
]

const acceptanceFrom = (el: HTMLElement): PlanAcceptance | { readonly invalid: true } => {
  const status = (el.getAttribute("data-status") ?? "pending") as PlanAcceptanceStatus
  if (!STATUSES.includes(status)) return { invalid: true }
  const evidence = el.getAttribute("data-evidence")
  return {
    id: el.getAttribute("data-acceptance") ?? "",
    text: el.text.trim(),
    status,
    evidence: evidence && evidence.length > 0 ? evidence : null
  }
}

export const planLegacyCommentMessageId = (annotationId: string): string =>
  `${annotationId}:message:1`

const mentionedParticipantIdsFrom = (
  el: HTMLElement,
  diagnostics: Array<PlanHtmlDiagnostic>,
  messageId: string
): ReadonlyArray<string> => {
  const raw = el.getAttribute("data-mentioned-participant-ids")
  if (raw === undefined || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      parsed.some((participantId) => typeof participantId !== "string")
    ) {
      throw new Error("mentions must be a string array")
    }
    return [...new Set(parsed)]
  } catch {
    diagnostics.push({
      code: "invalid-comment-message",
      message: `Comment message "${messageId}" has invalid mentioned participant ids.`
    })
    return []
  }
}

const messageFrom = (
  el: HTMLElement,
  diagnostics: Array<PlanHtmlDiagnostic>,
  fallback: {
    readonly id: string
    readonly authorKind: "user" | "agent"
    readonly createdAt: string
    readonly deliveryState: PlanCommentMessageDeliveryState
    readonly pendingWhenMentioned: boolean
  }
): PlanCommentMessage => {
  const id = el.getAttribute("data-comment-message") ?? fallback.id
  const rawAuthorKind =
    el.getAttribute("data-author-kind") ?? el.getAttribute("data-author")
  const authorKind =
    rawAuthorKind === "agent"
      ? "agent"
      : rawAuthorKind === "user"
        ? "user"
        : fallback.authorKind
  const mentionedParticipantIds = mentionedParticipantIdsFrom(el, diagnostics, id)
  const rawDeliveryState =
    el.getAttribute("data-delivery-state") ??
    (fallback.pendingWhenMentioned && mentionedParticipantIds.length > 0
      ? "pending"
      : fallback.deliveryState)
  const deliveryState = MESSAGE_DELIVERY_STATES.find(
    (candidate) => candidate === rawDeliveryState
  )
  if (id.length === 0 || deliveryState === undefined) {
    diagnostics.push({
      code: "invalid-comment-message",
      message:
        id.length === 0
          ? "Every comment message needs a stable data-comment-message id."
          : `Comment message "${id}" has invalid delivery state "${rawDeliveryState}".`
    })
  }
  const mentionDeliveries = mentionDeliveriesFrom(el, diagnostics, id)
  return {
    id,
    body: el.text.trim(),
    authorKind,
    authorId: el.getAttribute("data-author-id") ?? authorKind,
    createdAt: el.getAttribute("data-created-at") ?? fallback.createdAt,
    mentionedParticipantIds,
    deliveryState: deliveryState ?? fallback.deliveryState,
    ...(mentionDeliveries === undefined ? {} : { mentionDeliveries })
  }
}

const annotationFrom = (
  el: HTMLElement,
  diagnostics: Array<PlanHtmlDiagnostic> = []
): PlanAnnotation => {
  const id = el.getAttribute("data-annotation") ?? ""
  const author = el.getAttribute("data-author") === "agent" ? "agent" : "user"
  const status = el.getAttribute("data-status") === "resolved" ? "resolved" : "open"
  const createdAt = el.getAttribute("data-created-at") ?? new Date(0).toISOString()
  const messageElements = el.querySelectorAll("[data-comment-message]")
  const messages =
    messageElements.length > 0
      ? messageElements.map((message) =>
          messageFrom(message, diagnostics, {
            id: "",
            authorKind: author,
            createdAt,
            deliveryState: "sent",
            pendingWhenMentioned: author === "user" && status === "open"
          })
        )
      : [
          messageFrom(el, diagnostics, {
            id: planLegacyCommentMessageId(id),
            authorKind: author,
            createdAt,
            deliveryState: "sent",
            pendingWhenMentioned: author === "user" && status === "open"
          })
        ]
  const firstMessage = messages[0]!
  const quote = el.getAttribute("data-quote")
  return {
    id,
    stageId: el.getAttribute("data-stage") || null,
    body: firstMessage.body,
    author: firstMessage.authorKind,
    createdAt: firstMessage.createdAt,
    messages,
    status,
    ...(quote
      ? {
          anchor: {
            quote,
            prefix: el.getAttribute("data-prefix") ?? "",
            suffix: el.getAttribute("data-suffix") ?? ""
          }
        }
      : {})
  }
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section"

/**
 * Parse + sanitize a plan HTML document into its PlanPrd projection. The
 * returned html is the sanitized source that callers must persist (never the
 * raw input).
 */
export const parsePlanHtml = (
  source: string,
  options: { readonly validateExecutionGraph?: boolean } = {}
): PlanHtmlResult => {
  const html = sanitizePlanHtml(source)
  const diagnostics: Array<PlanHtmlDiagnostic> = []
  const root = parse(html)

  const title = root.querySelector("h1")?.text.trim() ?? ""
  if (title.length === 0) {
    diagnostics.push({ code: "missing-title", message: "A plan must start with an <h1> title." })
  }

  const ids = new Set<string>()
  const claim = (id: string): void => {
    if (id.length === 0) return
    if (ids.has(id)) {
      diagnostics.push({ code: "duplicate-id", message: `Duplicate plan id "${id}".` })
    }
    ids.add(id)
  }

  // Annotations that live outside a stage are global (stage-less).
  const annotations: Array<PlanAnnotation> = []
  for (const el of root.querySelectorAll("[data-annotation]")) {
    claim(el.getAttribute("data-annotation") ?? "")
    const annotation = annotationFrom(el, diagnostics)
    for (const message of annotation.messages) claim(message.id)
    annotations.push(annotation)
  }

  const stages: Array<PlanPrdStage> = []
  for (const el of root.querySelectorAll("section[data-stage]")) {
    const id = el.getAttribute("data-stage") ?? ""
    claim(id)
    const acceptance: Array<PlanAcceptance> = []
    for (const crit of el.querySelectorAll("[data-acceptance]")) {
      claim(crit.getAttribute("data-acceptance") ?? "")
      const parsed = acceptanceFrom(crit)
      if ("invalid" in parsed) {
        diagnostics.push({
          code: "invalid-status",
          message: `Acceptance "${crit.getAttribute("data-acceptance")}" has an invalid status.`
        })
        continue
      }
      acceptance.push(parsed)
    }
    if (acceptance.length === 0) {
      diagnostics.push({
        code: "missing-acceptance",
        message: `Stage "${id}" must contain at least one acceptance criterion.`
      })
    }
    const intent = el.querySelectorAll("h3").find((h) => /intent/i.test(h.text))
    const rawComplexity = el.getAttribute("data-complexity") ?? "medium"
    const complexity = COMPLEXITIES.find((candidate) => candidate === rawComplexity)
    if (complexity === undefined) {
      diagnostics.push({
        code: "invalid-complexity",
        message: `Stage "${id}" has invalid complexity "${rawComplexity}". Use low, medium, or high.`
      })
    }

    const assignmentElements = el.querySelectorAll("[data-assignment]")
    if (assignmentElements.length > 1) {
      diagnostics.push({
        code: "invalid-assignment",
        message: `Stage "${id}" must contain at most one worker assignment.`
      })
    }
    const assignmentElement = assignmentElements[0]
    let assignment: PlanStageAssignment | null = null
    let executionStatus: PlanStageExecutionStatus = "queued"
    if (assignmentElement !== undefined) {
      const agentId =
        assignmentElement.getAttribute("data-agent-id") ??
        assignmentElement.getAttribute("data-assignment") ??
        ""
      const rawCli = assignmentElement.getAttribute("data-cli") ?? ""
      const cli = CLI_KINDS.find((candidate) => candidate === rawCli)
      const model = assignmentElement.getAttribute("data-model") ?? ""
      const reason = assignmentElement.getAttribute("data-reason") ?? ""
      const rawExecutionStatus = assignmentElement.getAttribute("data-status") ?? "queued"
      const parsedExecutionStatus = EXECUTION_STATUSES.find(
        (candidate) => candidate === rawExecutionStatus
      )
      if (parsedExecutionStatus === undefined) {
        diagnostics.push({
          code: "invalid-execution-status",
          message: `Stage "${id}" has invalid execution status "${rawExecutionStatus}".`
        })
      } else {
        executionStatus = parsedExecutionStatus
      }
      if (
        agentId.trim().length === 0 ||
        cli === undefined ||
        model.trim().length === 0 ||
        reason.trim().length === 0
      ) {
        diagnostics.push({
          code: "invalid-assignment",
          message: `Stage "${id}" assignment needs data-agent-id, a supported data-cli, data-model, and data-reason.`
        })
      } else {
        assignment = { agentId, cli, model, reason }
      }
    } else {
      const rawExecutionStatus = el.getAttribute("data-execution-status")
      if (rawExecutionStatus !== undefined) {
        const parsedExecutionStatus = EXECUTION_STATUSES.find(
          (candidate) => candidate === rawExecutionStatus
        )
        if (parsedExecutionStatus === undefined) {
          diagnostics.push({
            code: "invalid-execution-status",
            message: `Stage "${id}" has invalid execution status "${rawExecutionStatus}".`
          })
        } else {
          executionStatus = parsedExecutionStatus
        }
      }
    }
    stages.push({
      id,
      title: el.getAttribute("data-title") ?? "",
      intent: intent?.nextElementSibling?.text.trim() ?? "",
      markdown: el.innerHTML.trim(),
      acceptance,
      dependencies: dependenciesFrom(el),
      complexity: complexity ?? "medium",
      assignment,
      executionStatus
    })
  }
  if (stages.length === 0) {
    diagnostics.push({ code: "missing-stage", message: "A plan must contain at least one stage." })
  }
  if (options.validateExecutionGraph !== false) {
    for (const diagnostic of buildPlanExecutionGraph(stages).diagnostics) {
      diagnostics.push({ code: diagnostic.code, message: diagnostic.message })
    }
  }

  // Prose sections: each top-level <h2> and the flow until the next <h2>/stage.
  const sections: Array<PlanPrdSection> = []
  const top = root.childNodes.filter(
    (n) => n.nodeType === NodeType.ELEMENT_NODE
  ) as Array<HTMLElement>
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!
    if (el.rawTagName?.toLowerCase() !== "h2") continue
    const body: Array<string> = []
    for (let j = i + 1; j < top.length; j++) {
      const next = top[j]!
      const tag = next.rawTagName?.toLowerCase()
      if (tag === "h2" || (tag === "section" && next.hasAttribute("data-stage"))) break
      body.push(next.toString())
    }
    const sectionTitle = el.text.trim()
    sections.push({ id: slug(sectionTitle), title: sectionTitle, markdown: body.join("\n").trim() })
  }

  if (html.trim().length === 0) {
    diagnostics.push({ code: "empty", message: "A plan cannot be empty." })
  }

  if (diagnostics.length > 0) {
    return { valid: false, projection: null, html, diagnostics }
  }
  return { valid: true, projection: { title, sections, stages, annotations }, html, diagnostics: [] }
}

export const formatPlanHtmlDiagnostics = (
  diagnostics: ReadonlyArray<PlanHtmlDiagnostic>
): string => diagnostics.map((d) => d.message).join("\n")

const escapeAttr = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const commentMessageHtml = (message: PlanCommentMessage): string => {
  const deliveryAttr =
    message.mentionDeliveries === undefined
      ? ""
      : ` data-mention-deliveries="${encodeURIComponent(JSON.stringify(message.mentionDeliveries))}"`
  return `<div data-comment-message="${escapeAttr(message.id)}" data-author-kind="${message.authorKind}" data-author-id="${escapeAttr(message.authorId)}" data-created-at="${escapeAttr(message.createdAt)}" data-mentioned-participant-ids="${escapeAttr(JSON.stringify(message.mentionedParticipantIds))}" data-delivery-state="${message.deliveryState}"${deliveryAttr}>${escapeText(message.body)}</div>`
}

const annotationElement = (root: HTMLElement, annotationId: string): HTMLElement | null =>
  root
    .querySelectorAll("aside[data-annotation]")
    .find((candidate) => candidate.getAttribute("data-annotation") === annotationId) ?? null

/** Materialize a legacy body-only annotation as canonical nested message markup. */
const materializeCommentMessages = (annotation: HTMLElement): ReadonlyArray<HTMLElement> => {
  const existing = annotation.querySelectorAll("[data-comment-message]")
  if (existing.length > 0) return existing
  const legacy = annotationFrom(annotation).messages[0]
  if (legacy === undefined) return []
  annotation.set_content(commentMessageHtml(legacy))
  return annotation.querySelectorAll("[data-comment-message]")
}

/**
 * Set an acceptance criterion's status/evidence in place. Used server-side to
 * mark a criterion passed from execution evidence, without a full editor.
 * Returns null if the criterion id is absent (caller keeps the old source).
 */
export const updatePlanCriterionHtml = (
  html: string,
  criterionId: string,
  status: PlanAcceptanceStatus,
  evidence: string | null
): string | null => {
  const root = parse(html)
  const el = root.querySelector(`[data-acceptance="${criterionId}"]`)
  if (el === null) return null
  el.setAttribute("data-status", status)
  if (evidence === null || evidence.length === 0) el.removeAttribute("data-evidence")
  else el.setAttribute("data-evidence", evidence)
  return root.toString()
}

/**
 * Update one stage's durable worker state without rewriting planner-owned
 * prose. Assigned stages carry the state on their assignment card; legacy
 * stages use the section-level fallback attribute.
 */
export const updatePlanStageExecutionHtml = (
  html: string,
  stageId: string,
  status: PlanStageExecutionStatus
): string | null => {
  const root = parse(html)
  const stage = root.querySelector(`section[data-stage="${stageId}"]`)
  if (stage === null) return null
  const assignment = stage.querySelector("[data-assignment]")
  if (assignment === null) stage.setAttribute("data-execution-status", status)
  else assignment.setAttribute("data-status", status)
  return root.toString()
}

/**
 * Record or replace a mechanical worker note using a stable annotation id.
 * Replacing keeps retries from appending the same blocker repeatedly.
 */
export const upsertPlanWorkerAnnotationHtml = (
  html: string,
  annotation: {
    readonly id: string
    readonly stageId: string
    readonly body: string
    readonly status: "open" | "resolved"
    readonly createdAt: string
    readonly authorId?: string
  }
): string | null => {
  const root = parse(html)
  const stage = root.querySelector(
    `section[data-stage="${annotation.stageId}"]`
  )
  if (stage === null) return null
  const existing = annotationElement(root, annotation.id)
  const message: PlanCommentMessage = {
    id: planLegacyCommentMessageId(annotation.id),
    body: annotation.body,
    authorKind: "agent",
    authorId: annotation.authorId ?? "agent",
    createdAt: annotation.createdAt,
    mentionedParticipantIds: [],
    deliveryState: "sent"
  }
  if (existing !== null) {
    const messages = materializeCommentMessages(existing)
    const workerMessage = messages.find(
      (candidate) =>
        candidate.getAttribute("data-comment-message") === message.id
    )
    if (workerMessage === undefined) {
      existing.insertAdjacentHTML("afterbegin", commentMessageHtml(message))
    } else {
      workerMessage.set_content(escapeText(annotation.body))
      workerMessage.setAttribute("data-author-kind", "agent")
      workerMessage.setAttribute("data-author-id", message.authorId)
      workerMessage.setAttribute("data-mentioned-participant-ids", "[]")
      workerMessage.setAttribute("data-delivery-state", "sent")
    }
    existing.setAttribute("data-stage", annotation.stageId)
    existing.setAttribute("data-author", "agent")
    existing.setAttribute("data-author-id", message.authorId)
    existing.setAttribute("data-status", annotation.status)
    return root.toString()
  }
  stage.insertAdjacentHTML(
    "beforeend",
    `<aside data-annotation="${escapeAttr(annotation.id)}" data-stage="${escapeAttr(annotation.stageId)}" data-author="agent" data-author-id="${escapeAttr(message.authorId)}" data-status="${annotation.status}" data-created-at="${escapeAttr(annotation.createdAt)}">${commentMessageHtml(message)}</aside>`
  )
  return root.toString()
}

/** Resolve a prior worker blocker/failure note after a successful retry. */
export const resolvePlanWorkerAnnotationHtml = (
  html: string,
  annotationId: string
): string => {
  const root = parse(html)
  root
    .querySelector(`[data-annotation="${annotationId}"]`)
    ?.setAttribute("data-status", "resolved")
  return root.toString()
}

/** Append an annotation into its stage (or globally) as an <aside> node. */
export const appendPlanAnnotationHtml = (
  html: string,
  annotation: {
    readonly id: string
    readonly stageId: string | null
    readonly body: string
    readonly author: "user" | "agent"
    readonly authorId?: string
    readonly createdAt: string
    readonly messageId?: string
    readonly mentionedParticipantIds?: ReadonlyArray<string>
    readonly deliveryState?: PlanCommentMessageDeliveryState
    readonly anchor?: { readonly quote: string; readonly prefix: string; readonly suffix: string }
  }
): string => {
  const anchorAttrs =
    annotation.anchor === undefined
      ? ""
      : ` data-quote="${escapeAttr(annotation.anchor.quote)}" data-prefix="${escapeAttr(annotation.anchor.prefix)}" data-suffix="${escapeAttr(annotation.anchor.suffix)}"`
  const stageAttr =
    annotation.stageId === null ? "" : ` data-stage="${escapeAttr(annotation.stageId)}"`
  const message: PlanCommentMessage = {
    id: annotation.messageId ?? planLegacyCommentMessageId(annotation.id),
    body: annotation.body,
    authorKind: annotation.author,
    authorId: annotation.authorId ?? annotation.author,
    createdAt: annotation.createdAt,
    mentionedParticipantIds: [...(annotation.mentionedParticipantIds ?? [])],
    deliveryState:
      annotation.deliveryState ??
      (annotation.mentionedParticipantIds?.length ? "pending" : "sent")
  }
  const aside = `<aside data-annotation="${escapeAttr(annotation.id)}"${stageAttr} data-author="${annotation.author}" data-author-id="${escapeAttr(message.authorId)}" data-status="open" data-created-at="${escapeAttr(annotation.createdAt)}"${anchorAttrs}>${commentMessageHtml(message)}</aside>`
  const root = parse(html)
  const stage =
    annotation.stageId === null
      ? null
      : root.querySelector(`section[data-stage="${annotation.stageId}"]`)
  if (stage !== null) {
    stage.insertAdjacentHTML("beforeend", aside)
    return root.toString()
  }
  root.insertAdjacentHTML("beforeend", aside)
  return root.toString()
}

/** Append one ordered message to an existing annotation thread. */
export const appendPlanCommentMessageHtml = (
  html: string,
  annotationId: string,
  message: PlanCommentMessage
): string | null => {
  const root = parse(html)
  const annotation = annotationElement(root, annotationId)
  if (annotation === null) return null
  materializeCommentMessages(annotation)
  if (
    root
      .querySelectorAll("[data-comment-message]")
      .some((candidate) => candidate.getAttribute("data-comment-message") === message.id)
  ) {
    return null
  }
  annotation.insertAdjacentHTML("beforeend", commentMessageHtml(message))
  return root.toString()
}

/** Update one message's delivery state, materializing legacy markup if needed. */
export const updatePlanCommentMessageDeliveryHtml = (
  html: string,
  annotationId: string,
  messageId: string,
  deliveryState: PlanCommentMessageDeliveryState
): string | null => {
  const root = parse(html)
  const annotation = annotationElement(root, annotationId)
  if (annotation === null) return null
  const messages = materializeCommentMessages(annotation)
  const message = messages.find(
    (candidate) => candidate.getAttribute("data-comment-message") === messageId
  )
  if (message === undefined) return null
  message.setAttribute("data-delivery-state", deliveryState)
  return root.toString()
}

/** Replace the durable per-recipient outbox state for one comment message. */
export const updatePlanCommentMentionDeliveriesHtml = (
  html: string,
  annotationId: string,
  messageId: string,
  deliveries: ReadonlyArray<PlanCommentMentionDelivery>,
  deliveryState: PlanCommentMessageDeliveryState
): string | null => {
  const root = parse(html)
  const annotation = annotationElement(root, annotationId)
  if (annotation === null) return null
  const message = materializeCommentMessages(annotation).find(
    (candidate) => candidate.getAttribute("data-comment-message") === messageId
  )
  if (message === undefined) return null
  message.setAttribute(
    "data-mention-deliveries",
    encodeURIComponent(JSON.stringify(deliveries))
  )
  message.setAttribute("data-delivery-state", deliveryState)
  return root.toString()
}

/** Resolve or reopen a durable annotation thread without touching its messages. */
export const updatePlanAnnotationStatusHtml = (
  html: string,
  annotationId: string,
  status: "open" | "resolved"
): string | null => {
  const root = parse(html)
  const annotation = annotationElement(root, annotationId)
  if (annotation === null) return null
  materializeCommentMessages(annotation)
  annotation.setAttribute("data-status", status)
  return root.toString()
}

/**
 * Route a thread to the agent: resolve it and mark only pending user messages
 * sent. Legacy body-only annotations keep their original markup.
 */
export const routePlanAnnotationHtml = (
  html: string,
  annotationId: string
): string | null => {
  const root = parse(html)
  const annotation = annotationElement(root, annotationId)
  if (annotation === null) return null
  annotation.setAttribute("data-status", "resolved")
  for (const message of annotation.querySelectorAll("[data-comment-message]")) {
    if (
      message.getAttribute("data-author-kind") === "user" &&
      message.getAttribute("data-delivery-state") === "pending"
    ) {
      message.setAttribute("data-delivery-state", "sent")
    }
  }
  return root.toString()
}

/** The blank plan a user starts from, and the shape the agent is shown. */
export const DEFAULT_PLAN_TEMPLATE_HTML = `<h1>PRD: [short outcome]</h1>
<h2>Context</h2>
<p>[Why this work matters and who needs it.]</p>
<h2>Goals</h2>
<ul><li>[Outcome this plan must achieve.]</li></ul>
<h2>Non-goals</h2>
<ul><li>[Boundary that keeps this plan focused.]</li></ul>
<h2>Technical design</h2>
<p>[Describe the architecture and data flow.]</p>
<section data-stage="01" data-title="[First independently verifiable stage]" data-depends-on="" data-complexity="medium">
<h3>Intent</h3>
<p>[Why this stage exists.]</p>
<h3>Approach</h3>
<ol><li>[Bounded implementation action.]</li></ol>
<ul data-files><li>[Repository-relative file this stage may edit, or leave this list empty.]</li></ul>
<div data-acceptance="01.1" data-status="pending">[Observable assertion that proves this stage succeeded.]</div>
</section>
<h2>Testing</h2>
<p>[Unit, integration, and end-to-end coverage.]</p>
<h2>Risks</h2>
<ul><li>[Risk and mitigation.]</li></ul>
<h2>Rollout</h2>
<p>[How the change is introduced and, if necessary, reversed.]</p>`
