import type { Plan } from "@jingler/core"
import { parsePlanHtml } from "@jingler/core"

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
      return `<section data-stage="${attr(step.id)}" data-title="${attr(step.title)}"><h3>Intent</h3><p>${text(step.intent)}</p>${approach}${acceptance}</section>`
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
  return {
    id,
    summary: result.projection.title.replace(/^PRD:\s*/i, ""),
    structured: true,
    graph: null,
    steps: result.projection.stages.map((stage, index) => ({
      id: stage.id,
      number: stage.id || String(index + 1).padStart(2, "0"),
      title: stage.title,
      intent: stage.intent,
      approach: [],
      kind: "step",
      condition: null,
      parentId: null,
      dependsOn: [],
      blocks: [],
      files: [],
      guards: stage.acceptance.map((criterion) => ({
        text: criterion.text,
        status:
          criterion.status === "passed" ? "ok" : criterion.status === "failed" ? "warn" : "open"
      })),
      code: null,
      graph: null,
      diff: null,
      status: "proposed",
      flagged: false,
      changed: false
    })),
    comments: result.projection.annotations.map((annotation) => ({
      id: annotation.id,
      stepId: annotation.stageId ?? "",
      body: annotation.body,
      author: annotation.author,
      createdAt: annotation.createdAt,
      routed: annotation.status === "resolved"
    })),
    status: "proposed",
    raw: source
  }
}
