import {
  buildBacklinkIndex,
  buildIdentityIndex,
  buildMemoryIndex,
  compareText,
  extractCitationReferences,
  extractWikiLinks,
  resolveWikiLink,
  type MemoryPage
} from "@jingler/memory"

export type SearchMatchKind = "fulltext" | "index" | "wikilink" | "backlink"

export interface VaultSearchResult {
  readonly pageId: string
  readonly revision: number
  readonly path: string
  readonly title: string
  readonly citationIds: ReadonlyArray<string>
  readonly matchKinds: ReadonlyArray<SearchMatchKind>
  readonly snippet: string
  readonly score: number
}

export interface VaultSearchResponse {
  readonly query: string
  readonly results: ReadonlyArray<VaultSearchResult>
  readonly total: number
}

export interface SearchProjection {
  readonly indexMarkdown: string
  readonly logMarkdown: string
  readonly rows: ReadonlyArray<{
    readonly pageId: string
    readonly path: string
    readonly title: string
    readonly body: string
    readonly aliases: string
    readonly tags: string
  }>
}

const MARKDOWN_EXTENSION_PATTERN = /\.md$/i

const normalize = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()

const searchableBody = (body: string): string =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$1 $2")
    .replace(/[#>*_~\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const snippetFor = (body: string, query: string): string => {
  const plain = searchableBody(body)
  const normalizedBody = normalize(plain)
  const position = normalizedBody.indexOf(query)
  const start = position < 0 ? 0 : Math.max(0, position - 48)
  const end = Math.min(plain.length, start + 180)
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`
}

const includesQuery = (value: string, query: string): boolean => normalize(value).includes(query)

const matchKindsFor = (
  page: MemoryPage,
  query: string,
  backlinkMatches: ReadonlySet<string>
): ReadonlyArray<SearchMatchKind> => {
  const kinds = new Set<SearchMatchKind>()
  if (includesQuery(page.body, query)) kinds.add("fulltext")
  if (
    [page.id, page.path, page.title, ...page.aliases, ...page.tags].some((value) =>
      includesQuery(value, query)
    )
  ) {
    kinds.add("index")
  }
  for (const link of extractWikiLinks(page.body)) {
    if (includesQuery(link.target, query) || (link.label !== undefined && includesQuery(link.label, query))) {
      kinds.add("wikilink")
    }
  }
  if (backlinkMatches.has(page.id)) kinds.add("backlink")
  return [...kinds].sort(compareText)
}

const backlinkMatchesFor = (
  pages: ReadonlyArray<MemoryPage>,
  query: string
): ReadonlySet<string> => {
  const identities = buildIdentityIndex(pages)
  const matches = new Set<string>()
  for (const source of pages) {
    if (!includesQuery(source.title, query)) continue
    for (const link of extractWikiLinks(source.body)) {
      const target = link.target === "" ? source : resolveWikiLink(link.target, identities)
      if (target !== undefined && target.id !== source.id) matches.add(target.id)
    }
  }
  return matches
}

const resultScore = (page: MemoryPage, query: string, kinds: ReadonlyArray<SearchMatchKind>): number => {
  let score = kinds.length * 10
  if (normalize(page.title) === query) score += 100
  else if (includesQuery(page.title, query)) score += 40
  if (normalize(page.id) === query || normalize(page.path) === query) score += 80
  score += page.tags.filter((tag) => includesQuery(tag, query)).length * 5
  return score
}

export const searchAcceptedPages = (
  pages: ReadonlyArray<MemoryPage>,
  rawQuery: string,
  limit = 20,
  candidatePageIds?: ReadonlySet<string>
): VaultSearchResponse => {
  const query = normalize(rawQuery)
  if (query === "") return { query: rawQuery, results: [], total: 0 }
  const backlinkMatches = backlinkMatchesFor(pages, query)
  const results = pages
    .filter((page) => candidatePageIds === undefined || candidatePageIds.has(page.id))
    .map((page): VaultSearchResult | null => {
      const matchKinds = matchKindsFor(page, query, backlinkMatches)
      if (matchKinds.length === 0) return null
      return {
        pageId: page.id,
        revision: page.revision,
        path: page.path,
        title: page.title,
        citationIds: [...new Set(extractCitationReferences(page.body).map((citation) => citation.id))].sort(
          compareText
        ),
        matchKinds,
        snippet: snippetFor(page.body, query),
        score: resultScore(page, query, matchKinds)
      }
    })
    .filter((result): result is VaultSearchResult => result !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.title, right.title) ||
        compareText(left.pageId, right.pageId)
    )
  return { query: rawQuery, total: results.length, results: results.slice(0, Math.max(1, limit)) }
}

export const buildSearchProjection = (
  pages: ReadonlyArray<MemoryPage>,
  acceptedLog: ReadonlyArray<{ readonly occurredAt: string; readonly pageId: string; readonly revision: number }>
): SearchProjection => {
  const index = buildMemoryIndex(pages)
  const backlinks = buildBacklinkIndex(pages)
  const indexLines = ["# Memory index", ""]
  for (const page of index.pages) {
    const incoming = backlinks[page.id] ?? []
    const suffix = incoming.length === 0 ? "" : ` — backlinks: ${incoming.join(", ")}`
    indexLines.push(`- [[${page.path.replace(MARKDOWN_EXTENSION_PATTERN, "")}|${page.title}]]${suffix}`)
  }
  const logLines = [
    "# Memory log",
    "",
    ...[...acceptedLog]
      .sort(
        (left, right) =>
          compareText(left.occurredAt, right.occurredAt) || compareText(left.pageId, right.pageId)
      )
      .map((entry) => `- ${entry.occurredAt} ${entry.pageId}@${entry.revision}`)
  ]
  return {
    indexMarkdown: `${indexLines.join("\n")}\n`,
    logMarkdown: `${logLines.join("\n")}\n`,
    rows: [...pages]
      .sort((left, right) => compareText(left.id, right.id))
      .map((page) => ({
        pageId: page.id,
        path: page.path,
        title: page.title,
        body: searchableBody(page.body),
        aliases: page.aliases.join(" "),
        tags: page.tags.join(" ")
      }))
  }
}
