import { maskPlanCode } from "./plan-mdx.js"
import type {
  PlanAcceptanceStatus,
  PlanDocumentAuthor
} from "./plan-document.js"

const blankLine = (value: string): string => value.replace(/[^\n]/g, " ")

const escapedId = (id: string): string => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const xmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
const xmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")

export const updatePlanCriterionSource = (
  source: string,
  criterionId: string,
  status: PlanAcceptanceStatus,
  evidence: string | null
): string | null => {
  const opening = new RegExp(
    `<Acceptance\\b(?=[^>]*\\bid="${escapedId(criterionId)}")[^>]*>`
  )
  if (!opening.test(source)) return null
  return source.replace(opening, (tag) => {
    const clean = tag
      .replace(/\sstatus="[^"]*"/, "")
      .replace(/\sevidence="[^"]*"/, "")
    const proof = evidence === null ? "" : ` evidence="${xmlAttribute(evidence)}"`
    return `${clean.slice(0, -1)} status="${status}"${proof}>`
  })
}

/**
 * Replace the prose body of a top-level `## <title>` section in place, leaving
 * every other byte of the plan source untouched.
 *
 * This is the write path behind inline (WYSIWYG) editing of a section: the
 * ProseMirror editor emits fresh markdown for one section, and this splices it
 * back so the MDX file stays the authoritative source of truth. Only the section
 * body changes — the heading, sibling sections, and every Stage/Annotation block
 * are preserved verbatim.
 *
 * A section's body runs from the end of its heading line to the NEXT structural
 * boundary: the next `## ` heading, or the first `<Stage>`/`<Annotation>` block,
 * whichever comes first (else end of source). Headings and component tags are
 * located on a code-masked view so a `##` or `<Stage` inside a fenced example is
 * never mistaken for a real one.
 *
 * Returns `null` if no section with that title exists (caller keeps the old
 * source unchanged).
 */
export const updatePlanSectionSource = (
  source: string,
  sectionTitle: string,
  markdown: string
): string | null => {
  const codeMasked = maskPlanCode(source)

  // Blank Stage/Annotation blocks too (offsets preserved) so their inner `##`
  // never registers as a section heading.
  let fullMask = codeMasked
  const componentBlock = /<(?:Stage|Annotation)\b[^>]*>[\s\S]*?<\/(?:Stage|Annotation)>/g
  for (const match of codeMasked.matchAll(componentBlock)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    fullMask = fullMask.slice(0, start) + blankLine(fullMask.slice(start, end)) + fullMask.slice(end)
  }

  const headings = [...fullMask.matchAll(/^##[ \t]+(.+)$/gm)]
  const target = headings.find((heading) => heading[1]!.trim() === sectionTitle.trim())
  if (!target || target.index === undefined) return null

  const headingStart = target.index
  const bodyStart = headingStart + target[0].length

  const boundaries: Array<number> = [source.length]
  for (const heading of headings) {
    if ((heading.index ?? 0) > headingStart) boundaries.push(heading.index ?? 0)
  }
  for (const match of codeMasked.matchAll(/<(?:Stage|Annotation)\b/g)) {
    if ((match.index ?? 0) > headingStart) boundaries.push(match.index ?? 0)
  }
  const bodyEnd = Math.min(...boundaries)

  const before = source.slice(0, bodyStart)
  const after = source.slice(bodyEnd).replace(/^\n+/, "")
  const body = markdown.trim()
  return `${before}\n\n${body === "" ? "" : `${body}\n\n`}${after}`
}

export const appendPlanAnnotationSource = (
  source: string,
  annotation: {
    readonly id: string
    readonly stageId: string | null
    readonly body: string
    readonly author: PlanDocumentAuthor
    readonly createdAt: string
  }
): string => {
  const component = `<Annotation id="${xmlAttribute(annotation.id)}"${annotation.stageId === null ? "" : ` stageId="${xmlAttribute(annotation.stageId)}"`} author="${annotation.author}" status="open" createdAt="${xmlAttribute(annotation.createdAt)}">
${xmlText(annotation.body)}
</Annotation>`
  if (annotation.stageId === null) return `${source.trimEnd()}\n\n${component}\n`

  const stage = new RegExp(
    `(<Stage\\b(?=[^>]*\\bid="${escapedId(annotation.stageId)}")[^>]*>[\\s\\S]*?)(</Stage>)`
  )
  return stage.test(source)
    ? source.replace(stage, `$1\n\n${component}\n\n$2`)
    : `${source.trimEnd()}\n\n${component}\n`
}
