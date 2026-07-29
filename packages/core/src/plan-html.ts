import { type HTMLElement, NodeType, parse } from "node-html-parser"
import type {
  PlanAcceptance,
  PlanAcceptanceStatus,
  PlanAnnotation,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage
} from "./plan-document.js"

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
 *   <section data-stage="01" data-title="...">        a stage
 *     <div data-acceptance="01.1" data-status="pending" data-evidence="...">...</div>
 *     <aside data-annotation="a1" data-stage="01" data-author="user"
 *            data-status="open" data-quote="..." data-prefix="..." data-suffix="...">...</aside>
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
  "data-quote", "data-prefix", "data-suffix", "data-diagram",
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

const annotationFrom = (el: HTMLElement): PlanAnnotation => {
  const quote = el.getAttribute("data-quote")
  return {
    id: el.getAttribute("data-annotation") ?? "",
    stageId: el.getAttribute("data-stage") || null,
    body: el.text.trim(),
    author: el.getAttribute("data-author") === "agent" ? "agent" : "user",
    status: el.getAttribute("data-status") === "resolved" ? "resolved" : "open",
    createdAt: el.getAttribute("data-created-at") ?? new Date(0).toISOString(),
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
export const parsePlanHtml = (source: string): PlanHtmlResult => {
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
    annotations.push(annotationFrom(el))
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
    stages.push({
      id,
      title: el.getAttribute("data-title") ?? "",
      intent: intent?.nextElementSibling?.text.trim() ?? "",
      markdown: el.innerHTML.trim(),
      acceptance
    })
  }
  if (stages.length === 0) {
    diagnostics.push({ code: "missing-stage", message: "A plan must contain at least one stage." })
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

/** Append an annotation into its stage (or globally) as an <aside> node. */
export const appendPlanAnnotationHtml = (
  html: string,
  annotation: {
    readonly id: string
    readonly stageId: string | null
    readonly body: string
    readonly author: "user" | "agent"
    readonly createdAt: string
    readonly anchor?: { readonly quote: string; readonly prefix: string; readonly suffix: string }
  }
): string => {
  const anchorAttrs =
    annotation.anchor === undefined
      ? ""
      : ` data-quote="${escapeAttr(annotation.anchor.quote)}" data-prefix="${escapeAttr(annotation.anchor.prefix)}" data-suffix="${escapeAttr(annotation.anchor.suffix)}"`
  const stageAttr =
    annotation.stageId === null ? "" : ` data-stage="${escapeAttr(annotation.stageId)}"`
  const aside = `<aside data-annotation="${escapeAttr(annotation.id)}"${stageAttr} data-author="${annotation.author}" data-status="open" data-created-at="${escapeAttr(annotation.createdAt)}"${anchorAttrs}>${escapeText(annotation.body)}</aside>`
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
<section data-stage="01" data-title="[First independently verifiable stage]">
<h3>Intent</h3>
<p>[Why this stage exists.]</p>
<h3>Approach</h3>
<ol><li>[Bounded implementation action.]</li></ol>
<div data-acceptance="01.1" data-status="pending">[Observable assertion that proves this stage succeeded.]</div>
</section>
<h2>Testing</h2>
<p>[Unit, integration, and end-to-end coverage.]</p>
<h2>Risks</h2>
<ul><li>[Risk and mitigation.]</li></ul>
<h2>Rollout</h2>
<p>[How the change is introduced and, if necessary, reversed.]</p>`
