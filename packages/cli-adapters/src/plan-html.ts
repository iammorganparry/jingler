import type { Plan } from "@jingler/core"
import { parsePlanHtml, planDocumentToPlan } from "@jingler/core"

export {
  DEFAULT_PLAN_TEMPLATE_HTML,
  formatPlanHtmlDiagnostics,
  parsePlanHtml,
  sanitizePlanHtml
} from "@jingler/core"
export type { PlanHtmlDiagnostic, PlanHtmlResult } from "@jingler/core"

const attr = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const text = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const statusAttr = (s: "ok" | "warn" | "open" | "under-review"): string =>
  s === "ok" ? "passed" : s === "warn" ? "failed" : s === "under-review" ? "waived" : "pending"

const CANONICAL_ANNOTATION_TAG = /<aside\b[^>]*>/g
const ANNOTATION_ID_ATTR = /\bdata-annotation=(["'])([^"']+)\1/
const ANNOTATION_STATUS_ATTR = /\bdata-status=(["'])[^"']*\1/
const TAG_END = />$/

/** Convert the former structured `Plan` projection into canonical plan HTML. */
export const legacyPlanToHtml = (plan: Plan): string => {
  const steps =
    plan.steps.length > 0
      ? plan.steps
      : [
          {
            id: "imported-stage",
            number: "01",
            title: "Verify imported plan",
            intent: "Review and carry out the imported implementation plan.",
            approach: [] as ReadonlyArray<string>,
            guards: [{ text: "The imported plan has been implemented and verified.", status: "open" as const }]
          }
        ]
  const stages = steps
    .map((step) => {
      const guards =
        step.guards.length > 0
          ? step.guards
          : [{ text: `Stage ${step.number} implementation is verified.`, status: "open" as const }]
      const acceptance = guards
        .map(
          (g, i) =>
            `<div data-acceptance="${attr(`${step.id}.${i + 1}`)}" data-status="${statusAttr(g.status)}">${text(g.text)}</div>`
        )
        .join("\n")
      const approach =
        step.approach.length === 0
          ? ""
          : `<h3>Approach</h3><ol>${step.approach.map((a) => `<li>${text(a)}</li>`).join("")}</ol>`
      const stepFiles = "files" in step ? step.files : []
      const files =
        stepFiles.length === 0
          ? ""
          : `<ul data-files>${stepFiles
              .map(
                (f) =>
                  `<li data-change="${attr(f.change)}" data-added="${f.added}" data-removed="${f.removed}">${text(f.path)}</li>`
              )
              .join("")}</ul>`
      return `<section data-stage="${attr(step.id)}" data-title="${attr(step.title)}"><h3>Intent</h3><p>${text(step.intent)}</p>${approach}${files}${acceptance}</section>`
    })
    .join("\n")
  const annotations = plan.comments
    .map(
      (c) =>
        `<aside data-annotation="${attr(c.id)}"${c.stepId.length === 0 ? "" : ` data-stage="${attr(c.stepId)}"`} data-author="${c.author}" data-status="${c.routed ? "resolved" : "open"}" data-created-at="${attr(c.createdAt)}">${text(c.body)}</aside>`
    )
    .join("\n")
  const design =
    plan.raw.trim().length > 0 ? `<p>${text(plan.raw.trim())}</p>` : "<p>See the stages below.</p>"
  return `<h1>PRD: ${text(plan.summary || "Implementation plan")}</h1>
<h2>Context</h2>
<p>Imported from a legacy native plan artifact. The source below is now canonical.</p>
<h2>Technical design</h2>
${design}
${stages}
${annotations}
<h2>Testing</h2>
<p>Each stage records acceptance evidence before the plan can be marked done.</p>
<h2>Rollout</h2>
<p>Implement stages in order and keep the canonical revision recoverable.</p>`
}

/** Derive the legacy transcript projection while native surfaces migrate to PlanDocument. */
export const planFromHtml = (source: string, id: string): Plan | null => {
  const result = parsePlanHtml(source)
  if (!result.valid) return null
  return planDocumentToPlan({
    id,
    sessionId: "",
    producingChatId: "",
    revision: 1,
    status: "proposed",
    source: result.html,
    projection: result.projection,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "agent"
  })
}

/**
 * Mark only the routed canonical annotations resolved. Attribute order is not
 * significant in HTML, so inspect each `<aside>` tag rather than matching one
 * serializer's exact layout.
 */
export const resolvePlanAnnotations = (
  source: string,
  annotationIds: ReadonlySet<string>
): string =>
  source.replace(CANONICAL_ANNOTATION_TAG, (tag) => {
    const idMatch = ANNOTATION_ID_ATTR.exec(tag)
    const id = idMatch?.[2]
    if (id === undefined || !annotationIds.has(id)) return tag
    if (ANNOTATION_STATUS_ATTR.test(tag)) {
      return tag.replace(ANNOTATION_STATUS_ATTR, 'data-status="resolved"')
    }
    return tag.replace(TAG_END, ' data-status="resolved">')
  })
