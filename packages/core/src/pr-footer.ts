export interface RelatedPr {
  readonly repo: string
  readonly number: number
  readonly url: string
}

const MARKER_START = "<!-- jingler:multi-repo -->"
const MARKER_END = "<!-- /jingler:multi-repo -->"
const BLOCK = new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`, "u")

/**
 * Append (or refresh) the "Part of an N-repo change" footer on `body` for the PR
 * `self`, listing every other PR. One PR gets no footer; an existing footer is
 * replaced, so applying it twice yields the same body.
 */
export const withMultiRepoFooter = (body: string, self: RelatedPr, all: ReadonlyArray<RelatedPr>): string => {
  const base = body.replace(BLOCK, "").trimEnd()
  const others = all.filter((pr) => !(pr.repo === self.repo && pr.number === self.number))
  if (others.length === 0) return base
  const lines = others.map((pr) => `- ${pr.repo}#${pr.number} — ${pr.url}`)
  return `${base}\n\n${MARKER_START}\n**Part of an ${all.length}-repo change**\n${lines.join("\n")}\n${MARKER_END}\n`
}
