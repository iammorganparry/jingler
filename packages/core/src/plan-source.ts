import type {
  PlanAcceptanceStatus,
  PlanDocumentAuthor
} from "./plan-document.js"

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
