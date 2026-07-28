import type {
  PlanAcceptance,
  PlanAnnotation,
  PlanPrd,
  PlanPrdSection,
  PlanPrdStage
} from "./plan-document.js"

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

const blank = (value: string): string => value.replace(/[^\n]/g, " ")

/**
 * Hide fenced and inline code while preserving every offset and newline.
 * Validation and component discovery share this view, so examples never become
 * executable MDX or phantom Stage/Acceptance records.
 *
 * Exported as `maskPlanCode` for surgical source rewriters (`plan-source.ts`),
 * which must locate `##` headings without matching ones inside a code fence.
 */
export const maskPlanCode = (source: string): string => {
  let masked = source
  const opening = /^[ \t]*(`{3,})[^\n]*\r?\n/gm
  let match = opening.exec(masked)
  while (match !== null) {
    const start = match.index
    const bodyStart = start + match[0].length
    const close = new RegExp(`^[ \\t]*\`{${match[1]!.length},}[ \\t]*$`, "gm")
    close.lastIndex = bodyStart
    const ending = close.exec(masked)
    const end = ending === null ? masked.length : ending.index + ending[0].length
    masked = masked.slice(0, start) + blank(masked.slice(start, end)) + masked.slice(end)
    opening.lastIndex = end
    match = opening.exec(masked)
  }
  return masked.replace(/(`+)(?!`)([\s\S]*?)\1(?!`)/g, (span) => blank(span))
}

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#123;", "{")
    .replaceAll("&#105;", "i")
    .replaceAll("&#101;", "e")
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

const bodyFrom = (
  source: string,
  offset: number,
  full: string,
  closingTag: string
): string => {
  const openingEnd = full.indexOf(">") + 1
  return source.slice(offset + openingEnd, offset + full.length - closingTag.length)
}

const removeDiscovered = (
  source: string,
  safe: string,
  patterns: ReadonlyArray<RegExp>
): string => {
  const ranges = patterns
    .flatMap((pattern) =>
      [...safe.matchAll(pattern)].map((match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length
      }))
    )
    .sort((left, right) => left.start - right.start)
  let result = ""
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    result += source.slice(cursor, range.start)
    cursor = range.end
  }
  return result + source.slice(cursor)
}

/** Parse Jingler's data-only MDX dialect without compiling or executing it. */
export const parsePlanMdx = (source: string): PlanMdxResult => {
  const diagnostics: Array<PlanMdxDiagnostic> = []
  const safe = maskPlanCode(source)

  for (const match of safe.matchAll(/^\s*(?:import|export)\b|(?<!\\)\{/gm)) {
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

  const title = /^#\s+(.+)$/m.exec(safe)?.[1]?.trim() ?? ""
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
  for (const match of safe.matchAll(/<Annotation\b([^>]*)>([\s\S]*?)<\/Annotation>/g)) {
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
      body: textOf(bodyFrom(source, offset, match[0], "</Annotation>")),
      author: props.author === "agent" ? "agent" : "user",
      status: props.status === "resolved" ? "resolved" : "open",
      createdAt: props.createdAt ?? new Date(0).toISOString()
    })
  }

  const stages: Array<PlanPrdStage> = []
  for (const match of safe.matchAll(/<Stage\b([^>]*)>([\s\S]*?)<\/Stage>/g)) {
    const props = attributes(match[1] ?? "")
    const offset = match.index ?? 0
    const body = bodyFrom(source, offset, match[0], "</Stage>")
    const safeBody = match[2] ?? ""
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
    for (const criterion of safeBody.matchAll(
      /<Acceptance\b([^>]*)>([\s\S]*?)<\/Acceptance>/g
    )) {
      const criterionProps = attributes(criterion[1] ?? "")
      const criterionOffset = offset + match[0].indexOf(">") + 1 + (criterion.index ?? 0)
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
      if (
        rawStatus !== "pending" &&
        rawStatus !== "passed" &&
        rawStatus !== "failed" &&
        rawStatus !== "waived"
      ) {
        diagnostics.push({
          code: "invalid-component",
          message: `Acceptance "${criterionProps.id}" has invalid status "${rawStatus}".`,
          line: lineAt(source, criterionOffset)
        })
        continue
      }
      const criterionBody = bodyFrom(
        body,
        criterion.index ?? 0,
        criterion[0],
        "</Acceptance>"
      )
      acceptance.push({
        id: criterionProps.id,
        text: textOf(criterionBody),
        status: rawStatus,
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

    const stageMarkdown = removeDiscovered(body, safeBody, [
      /<Acceptance\b([^>]*)>([\s\S]*?)<\/Acceptance>/g,
      /<Annotation\b([^>]*)>([\s\S]*?)<\/Annotation>/g
    ]).trim()
    stages.push({
      id: props.id,
      title: props.title,
      intent: intentOf(stageMarkdown),
      markdown: stageMarkdown,
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

  const sectionSource = removeDiscovered(source, safe, [
    /<Stage\b([^>]*)>([\s\S]*?)<\/Stage>/g,
    /<Annotation\b([^>]*)>([\s\S]*?)<\/Annotation>/g
  ])
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
