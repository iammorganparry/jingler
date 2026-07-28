import type { Plan } from "@jingler/core"
import { parsePlanMdx } from "@jingler/core"

export {
  formatPlanDiagnostics,
  parsePlanMdx
} from "@jingler/core"
export type { PlanMdxDiagnostic, PlanMdxResult } from "@jingler/core"

const attributeValue = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("\n", " ")

const markdownValue = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replace(
      /^(\s*)(import|export)\b/gm,
      (_match, whitespace: string, keyword: string) =>
        `${whitespace}&#${keyword.charCodeAt(0)};${keyword.slice(1)}`
    )

/** Convert the former structured plan projection into canonical PRD MDX once. */
export const legacyPlanToMdx = (plan: Plan): string => {
  const legacySteps =
    plan.steps.length > 0
      ? plan.steps
      : [
          {
            id: "imported-stage",
            number: "01",
            title: "Verify imported plan",
            intent: "Review and carry out the imported implementation plan.",
            approach: [],
            files: [],
            guards: [
              {
                text: "The imported plan has been implemented and verified.",
                status: "open" as const
              }
            ]
          }
        ]
  const stages = legacySteps.map((step) => {
    const approach =
      step.approach.length === 0
        ? ""
        : `\n### Approach\n\n${step.approach.map((item, index) => `${index + 1}. ${markdownValue(item)}`).join("\n")}\n`
    const files =
      step.files.length === 0
        ? ""
        : `\n### Files\n\n${step.files.map((file) => `- ${file.change} \`${markdownValue(file.path)}\` (+${file.added} −${file.removed})`).join("\n")}\n`
    const guards =
      step.guards.length > 0
        ? step.guards
        : [{ text: `Stage ${step.number} implementation is verified.`, status: "open" as const }]
    const acceptance = guards
      .map(
        (guard, index) =>
          `<Acceptance id="${attributeValue(`${step.id}.${index + 1}`)}" status="${guard.status === "ok" ? "passed" : guard.status === "warn" ? "failed" : guard.status === "under-review" ? "waived" : "pending"}">\n${markdownValue(guard.text)}\n</Acceptance>`
      )
      .join("\n\n")
    return `<Stage id="${attributeValue(step.id)}" title="${attributeValue(step.title)}">

### Intent

${markdownValue(step.intent)}
${approach}${files}
${acceptance}

</Stage>`
  })
  const annotations = plan.comments.map(
    (comment) =>
      `<Annotation id="${attributeValue(comment.id)}"${comment.stepId.length === 0 ? "" : ` stageId="${attributeValue(comment.stepId)}"`} author="${comment.author}" status="${comment.routed ? "resolved" : "open"}" createdAt="${attributeValue(comment.createdAt)}">\n${markdownValue(comment.body)}\n</Annotation>`
  )

  return `# PRD: ${markdownValue(plan.summary || "Implementation plan")}

## Context

Imported from a legacy native plan artifact. The source below is now canonical.

## Goals

- Deliver the approved implementation safely and verify every stage.

## Non-goals

- Preserve the retired parallel planning workflow.

## User experience

The operator reviews, edits, annotates, and approves this single PRD.

## Technical design

${plan.raw.trim().length > 0 ? markdownValue(plan.raw.trim()) : "See the stages below."}

${stages.join("\n\n")}

${annotations.join("\n\n")}

## Testing

Each stage records acceptance evidence before the plan can be marked done.

## Risks

- Imported prose may need human refinement; the original source is retained above.

## Rollout

Implement stages in order and keep the canonical revision recoverable.
`
}

/** Derive the legacy transcript projection while native surfaces migrate to PlanDocument. */
export const planFromMdx = (source: string, id: string): Plan | null => {
  const result = parsePlanMdx(source)
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
          criterion.status === "passed"
            ? "ok"
            : criterion.status === "failed"
              ? "warn"
              : "open"
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
