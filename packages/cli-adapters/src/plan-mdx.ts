import type {
  Plan,
  PlanAcceptance,
  PlanAcceptanceStatus,
  PlanAnnotation,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage
} from "@jingler/core"

export interface PlanMdxDiagnostic {
  readonly code:
    | "executable-mdx"
    | "unknown-component"
    | "invalid-component"
    | "duplicate-id"
    | "missing-stage"
    | "missing-acceptance"
    | "missing-title"
  readonly message: string
  readonly line: number
}

export type PlanMdxResult =
  | { readonly valid: true; readonly projection: PlanPrd; readonly diagnostics: readonly [] }
  | {
      readonly valid: false
      readonly projection: null
      readonly diagnostics: ReadonlyArray<PlanMdxDiagnostic>
    }

const lineAt = (source: string, offset: number): number =>
  source.slice(0, Math.max(0, offset)).split("\n").length

const withoutFences = (source: string): string =>
  source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "))

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#123;", "{")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

const attributes = (raw: string): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {}
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g
  for (const match of raw.matchAll(pattern)) result[match[1]!] = decodeEntities(match[2]!)
  return result
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section"

const textOf = (body: string): string => decodeEntities(body.trim())

const intentOf = (body: string): string => {
  const match = /(?:^|\n)###\s+Intent\s*\n([\s\S]*?)(?=\n###\s|\n<[A-Z]|\s*$)/i.exec(body)
  return match?.[1]?.trim() ?? ""
}

const allowedComponents = new Set(["Stage", "Acceptance", "Annotation"])

/**
 * Parse Jingler's data-only MDX dialect.
 *
 * This function deliberately does not invoke an MDX compiler. Markdown remains
 * source text and the three allowed JSX elements are projected into typed data,
 * so agent-authored input cannot import code or execute JavaScript.
 */
export const parsePlanMdx = (source: string): PlanMdxResult => {
  const diagnostics: Array<PlanMdxDiagnostic> = []
  const safe = withoutFences(source)

  for (const match of safe.matchAll(/^\s*(?:import|export)\b|(?<!\\)\{[^}\n]*\}/gm)) {
    diagnostics.push({
      code: "executable-mdx",
      message: "Plan MDX may not contain imports, exports, or JavaScript expressions.",
      line: lineAt(source, match.index ?? 0)
    })
  }

  for (const match of safe.matchAll(/<\/?([A-Z][A-Za-z0-9.]*)\b/g)) {
    const name = match[1]!
    if (!allowedComponents.has(name)) {
      diagnostics.push({
        code: "unknown-component",
        message: `Unknown MDX component <${name}>. Only Stage, Acceptance, and Annotation are allowed.`,
        line: lineAt(source, match.index ?? 0)
      })
    }
  }

  const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? ""
  if (title.length === 0) {
    diagnostics.push({
      code: "missing-title",
      message: "A plan must start with a level-one PRD title.",
      line: 1
    })
  }

  const ids = new Map<string, number>()
  const claimId = (id: string, offset: number): void => {
    const line = lineAt(source, offset)
    const previous = ids.get(id)
    if (previous !== undefined) {
      diagnostics.push({
        code: "duplicate-id",
        message: `Duplicate plan id "${id}" (first used on line ${previous}).`,
        line
      })
    } else {
      ids.set(id, line)
    }
  }

  const annotations: Array<PlanAnnotation> = []
  for (const match of source.matchAll(/<Annotation\b([^>]*)>([\s\S]*?)<\/Annotation>/g)) {
    const props = attributes(match[1] ?? "")
    const offset = match.index ?? 0
    if (!props.id) {
      diagnostics.push({
        code: "invalid-component",
        message: "Annotation requires a quoted id attribute.",
        line: lineAt(source, offset)
      })
      continue
    }
    claimId(props.id, offset)
    annotations.push({
      id: props.id,
      stageId: props.stageId || null,
      body: textOf(match[2] ?? ""),
      author: props.author === "agent" ? "agent" : "user",
      status: props.status === "resolved" ? "resolved" : "open",
      createdAt: props.createdAt ?? new Date(0).toISOString()
    })
  }

  const stages: Array<PlanPrdStage> = []
  for (const match of source.matchAll(/<Stage\b([^>]*)>([\s\S]*?)<\/Stage>/g)) {
    const props = attributes(match[1] ?? "")
    const body = match[2] ?? ""
    const offset = match.index ?? 0
    if (!props.id || !props.title) {
      diagnostics.push({
        code: "invalid-component",
        message: "Stage requires quoted id and title attributes.",
        line: lineAt(source, offset)
      })
      continue
    }
    claimId(props.id, offset)

    const acceptance: Array<PlanAcceptance> = []
    for (const criterion of body.matchAll(
      /<Acceptance\b([^>]*)>([\s\S]*?)<\/Acceptance>/g
    )) {
      const criterionProps = attributes(criterion[1] ?? "")
      const criterionOffset = offset + (criterion.index ?? 0)
      if (!criterionProps.id) {
        diagnostics.push({
          code: "invalid-component",
          message: `Acceptance in stage "${props.id}" requires a quoted id attribute.`,
          line: lineAt(source, criterionOffset)
        })
        continue
      }
      claimId(criterionProps.id, criterionOffset)
      const rawStatus = criterionProps.status ?? "pending"
      const statuses: ReadonlyArray<PlanAcceptanceStatus> = [
        "pending",
        "passed",
        "failed",
        "waived"
      ]
      if (!statuses.includes(rawStatus as PlanAcceptanceStatus)) {
        diagnostics.push({
          code: "invalid-component",
          message: `Acceptance "${criterionProps.id}" has invalid status "${rawStatus}".`,
          line: lineAt(source, criterionOffset)
        })
        continue
      }
      acceptance.push({
        id: criterionProps.id,
        text: textOf(criterion[2] ?? ""),
        status: rawStatus as PlanAcceptanceStatus,
        evidence: criterionProps.evidence || null
      })
    }

    if (acceptance.length === 0) {
      diagnostics.push({
        code: "missing-acceptance",
        message: `Stage "${props.id}" must contain at least one Acceptance criterion.`,
        line: lineAt(source, offset)
      })
    }

    stages.push({
      id: props.id,
      title: props.title,
      intent: intentOf(body),
      markdown: body
        .replace(/<Acceptance\b[^>]*>[\s\S]*?<\/Acceptance>/g, "")
        .replace(/<Annotation\b[^>]*>[\s\S]*?<\/Annotation>/g, "")
        .trim(),
      acceptance
    })
  }

  if (stages.length === 0) {
    diagnostics.push({
      code: "missing-stage",
      message: "A plan must contain at least one Stage.",
      line: 1
    })
  }

  const sectionSource = source
    .replace(/<Stage\b[^>]*>[\s\S]*?<\/Stage>/g, "")
    .replace(/<Annotation\b[^>]*>[\s\S]*?<\/Annotation>/g, "")
  const headings = [...sectionSource.matchAll(/^##\s+(.+)$/gm)]
  const sections: Array<PlanPrdSection> = headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length
    const end = headings[index + 1]?.index ?? sectionSource.length
    const sectionTitle = heading[1]!.trim()
    return {
      id: slug(sectionTitle),
      title: sectionTitle,
      markdown: sectionSource.slice(start, end).trim()
    }
  })

  if (diagnostics.length > 0) {
    return { valid: false, projection: null, diagnostics }
  }
  return {
    valid: true,
    projection: { title, sections, stages, annotations },
    diagnostics: []
  }
}

export const formatPlanDiagnostics = (
  diagnostics: ReadonlyArray<PlanMdxDiagnostic>
): string => diagnostics.map((item) => `Line ${item.line}: ${item.message}`).join("\n")

const attributeValue = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("\n", " ")

const markdownValue = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")

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
        : `\n### Files\n\n${step.files.map((file) => `- ${file.change} \`${file.path}\` (+${file.added} −${file.removed})`).join("\n")}\n`
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

  return `# PRD: ${plan.summary || "Implementation plan"}

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
