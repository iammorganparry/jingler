import { Schema } from "effect"
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js"
import {
  MemoryCitation as MemoryCitationSchema,
  MemoryPage as MemoryPageSchema,
  MemoryRelationship as MemoryRelationshipSchema,
  MemoryRelationshipKind as MemoryRelationshipKindSchema,
  MemorySource as MemorySourceSchema,
  MemorySourceKind as MemorySourceKindSchema,
  type MemoryCitation,
  type MemoryPage,
  type MemoryRelationship,
  type MemoryRelationshipKind,
  type MemorySource
} from "./model.js"

export class MemoryMarkdownParseError extends Error {
  override readonly name = "MemoryMarkdownParseError"

  constructor(message: string, readonly path?: string) {
    super(path === undefined ? message : `${path}: ${message}`)
  }
}

export interface WikiLink {
  readonly raw: string
  readonly target: string
  readonly anchor?: string
  readonly label?: string
  /** One-based source position. */
  readonly line: number
  /** One-based source position. */
  readonly column: number
}

export interface CitationReference {
  readonly id: string
  readonly raw: string
  readonly line: number
  readonly column: number
}

export interface MarkdownClaim {
  readonly text: string
  readonly citationIds: ReadonlyArray<string>
  readonly line: number
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  "id",
  "path",
  "title",
  "revision",
  "aliases",
  "tags",
  "sources",
  "citations",
  "relationships",
  "dependencies",
  "dependsOn",
  "schemas"
])

const NonEmptyString = Schema.String.pipe(Schema.filter((value) => value.trim() !== ""))
const NullableString = Schema.Union(Schema.String, Schema.Null)

const decodeFrontmatter = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  message: string,
  path: string | undefined
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw new MemoryMarkdownParseError(message, path)
  }
}

const requiredString = (
  value: unknown,
  field: string,
  path: string | undefined
): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemoryMarkdownParseError(`frontmatter field "${field}" must be a non-empty string`, path)
  }
  return value
}

const optionalString = (
  value: unknown,
  field: string,
  path: string | undefined
): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") {
    throw new MemoryMarkdownParseError(`frontmatter field "${field}" must be a string`, path)
  }
  return value
}

const stringArray = (value: unknown, field: string, path: string | undefined): Array<string> => {
  if (value === undefined || value === null || value === "") return []
  const decoded = decodeFrontmatter(
    Schema.Union(NonEmptyString, Schema.Array(NonEmptyString)),
    value,
    `frontmatter field "${field}" must contain non-empty strings`,
    path
  )
  return typeof decoded === "string" ? [decoded] : [...decoded]
}

const FrontmatterSource = Schema.Struct({
  id: NonEmptyString,
  kind: Schema.optional(MemorySourceKindSchema),
  title: Schema.optional(Schema.String),
  uri: Schema.optional(NullableString),
  retrievedAt: Schema.optional(NullableString),
  contentHash: Schema.optional(NullableString)
})

const normalizedOptionalString = (value: string | null | undefined): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : value

const parseSource = (value: unknown, path: string | undefined): MemorySource => {
  const decoded = decodeFrontmatter(
    FrontmatterSource,
    value,
    'frontmatter field "sources" must contain valid source mappings',
    path
  )
  const uri = normalizedOptionalString(decoded.uri)
  const retrievedAt = normalizedOptionalString(decoded.retrievedAt)
  const contentHash = normalizedOptionalString(decoded.contentHash)
  return Schema.decodeUnknownSync(MemorySourceSchema)({
    id: decoded.id,
    kind: decoded.kind ?? "other",
    title: decoded.title ?? decoded.id,
    ...(uri === undefined ? {} : { uri }),
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
    ...(contentHash === undefined ? {} : { contentHash })
  })
}

const FrontmatterCitationMapping = Schema.Struct({
  id: NonEmptyString,
  sourceId: Schema.optional(NonEmptyString),
  source: Schema.optional(NonEmptyString),
  locator: Schema.optional(NullableString),
  quote: Schema.optional(NullableString)
}).pipe(
  Schema.filter((citation) =>
    citation.sourceId !== undefined || citation.source !== undefined
      ? true
      : 'citation mapping must include "sourceId" or "source"'
  )
)
const FrontmatterCitation = Schema.Union(NonEmptyString, FrontmatterCitationMapping)

const parseCitation = (value: unknown, path: string | undefined): MemoryCitation => {
  const decoded = decodeFrontmatter(
    FrontmatterCitation,
    value,
    'frontmatter field "citations" must contain strings or valid mappings',
    path
  )
  if (typeof decoded === "string") return { id: decoded, sourceId: decoded }
  const locator = normalizedOptionalString(decoded.locator)
  const quote = normalizedOptionalString(decoded.quote)
  return Schema.decodeUnknownSync(MemoryCitationSchema)({
    id: decoded.id,
    sourceId: decoded.sourceId ?? decoded.source,
    ...(locator === undefined ? {} : { locator }),
    ...(quote === undefined ? {} : { quote })
  })
}

const headingTitle = (body: string): string | undefined => {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) return match[1]
  }
  return undefined
}

const idFromPath = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const filename = path.slice(slash + 1)
  return filename.replace(/\.md$/i, "") || undefined
}

const sourceArray = (value: unknown, path: string | undefined): Array<MemorySource> => {
  if (value === undefined || value === null || value === "") return []
  return decodeFrontmatter(
    Schema.Array(FrontmatterSource),
    value,
    'frontmatter field "sources" must be an array of valid source mappings',
    path
  ).map((entry) => parseSource(entry, path))
}

const citationArray = (value: unknown, path: string | undefined): Array<MemoryCitation> => {
  if (value === undefined || value === null || value === "") return []
  return decodeFrontmatter(
    Schema.Array(FrontmatterCitation),
    value,
    'frontmatter field "citations" must be an array of strings or valid mappings',
    path
  ).map((entry) => parseCitation(entry, path))
}

const FrontmatterRelationshipMapping = Schema.Struct({
  kind: Schema.optional(MemoryRelationshipKindSchema),
  target: Schema.optional(NonEmptyString),
  targetId: Schema.optional(NonEmptyString),
  label: Schema.optional(NullableString)
}).pipe(
  Schema.filter((relationship) =>
    relationship.target !== undefined || relationship.targetId !== undefined
      ? true
      : 'relationship mapping must include "target" or "targetId"'
  )
)

type FrontmatterRelationshipMapping = Schema.Schema.Type<
  typeof FrontmatterRelationshipMapping
>

const relationshipFromMapping = (
  decoded: FrontmatterRelationshipMapping,
  defaultKind: MemoryRelationshipKind | undefined,
  path: string | undefined
): MemoryRelationship => {
  const kind = decoded.kind ?? defaultKind
  if (kind === undefined) {
    throw new MemoryMarkdownParseError(
      'frontmatter relationship entries must include "kind"',
      path
    )
  }
  const label = normalizedOptionalString(decoded.label)
  return Schema.decodeUnknownSync(MemoryRelationshipSchema)({
    kind,
    target: decoded.target ?? decoded.targetId,
    ...(label === undefined ? {} : { label })
  })
}

const parseRelationship = (
  value: unknown,
  defaultKind: MemoryRelationshipKind | undefined,
  path: string | undefined
): MemoryRelationship => {
  if (defaultKind === undefined) {
    const decoded = decodeFrontmatter(
      FrontmatterRelationshipMapping,
      value,
      'frontmatter relationship entries must be valid mappings with "kind" and "target"',
      path
    )
    return relationshipFromMapping(decoded, undefined, path)
  }
  const decoded = decodeFrontmatter(
    Schema.Union(NonEmptyString, FrontmatterRelationshipMapping),
    value,
    'frontmatter relationship entries must be valid strings or mappings',
    path
  )
  return typeof decoded === "string"
    ? { kind: defaultKind, target: decoded }
    : relationshipFromMapping(decoded, defaultKind, path)
}

const relationshipEntries = (
  value: unknown,
  kind: MemoryRelationshipKind | undefined,
  field: string,
  path: string | undefined
): Array<MemoryRelationship> => {
  if (value === undefined || value === null || value === "") return []
  const entries =
    kind === undefined
      ? decodeFrontmatter(
          Schema.Array(FrontmatterRelationshipMapping),
          value,
          `frontmatter field "${field}" must be an array of valid relationships`,
          path
        )
      : decodeFrontmatter(
          Schema.Array(Schema.Union(NonEmptyString, FrontmatterRelationshipMapping)),
          value,
          `frontmatter field "${field}" must be an array of valid relationships`,
          path
        )
  return entries.map((entry) => parseRelationship(entry, kind, path))
}

export const parseMemoryRelationships = (
  attributes: Readonly<Record<string, unknown>>,
  path?: string
): Array<MemoryRelationship> => [
  ...relationshipEntries(attributes.relationships, undefined, "relationships", path),
  ...relationshipEntries(attributes.dependencies, "dependency", "dependencies", path),
  ...relationshipEntries(attributes.dependsOn, "dependency", "dependsOn", path),
  ...relationshipEntries(attributes.schemas, "schema", "schemas", path)
]

/**
 * Parse a Markdown page. `path` is optional when frontmatter declares one; if
 * neither does, a stable `<id>.md` path is used.
 */
export const parseMemoryMarkdown = (markdown: string, path?: string): MemoryPage => {
  const { attributes, body } = parseFrontmatter(markdown)
  const parsedPath = optionalString(attributes.path, "path", path)
  const id = requiredString(attributes.id ?? idFromPath(path), "id", path)
  if (path !== undefined && parsedPath !== undefined && path !== parsedPath) {
    throw new MemoryMarkdownParseError(
      `frontmatter path "${parsedPath}" does not match file path "${path}"`,
      path
    )
  }
  const resolvedPath = path ?? parsedPath ?? `${id}.md`
  const title = requiredString(attributes.title ?? headingTitle(body) ?? id, "title", resolvedPath)
  const revisionValue = attributes.revision ?? 1
  if (
    typeof revisionValue !== "number" ||
    !Number.isSafeInteger(revisionValue) ||
    revisionValue < 1
  ) {
    throw new MemoryMarkdownParseError('frontmatter field "revision" must be a positive integer', resolvedPath)
  }

  const metadata = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !KNOWN_FRONTMATTER_KEYS.has(key))
  )
  try {
    return Schema.decodeUnknownSync(MemoryPageSchema)({
      id,
      path: resolvedPath,
      title,
      revision: revisionValue,
      aliases: stringArray(attributes.aliases, "aliases", resolvedPath),
      tags: stringArray(attributes.tags, "tags", resolvedPath),
      sources: sourceArray(attributes.sources, resolvedPath),
      citations: citationArray(attributes.citations, resolvedPath),
      relationships: parseMemoryRelationships(attributes, resolvedPath),
      body,
      metadata
    })
  } catch (error) {
    throw new MemoryMarkdownParseError(`invalid memory page: ${String(error)}`, resolvedPath)
  }
}

/** Path-first convenience used by filesystem callers. */
export const parseMemoryPage = (path: string, markdown: string): MemoryPage =>
  parseMemoryMarkdown(markdown, path)

export const pageFrontmatter = (page: MemoryPage): Readonly<Record<string, unknown>> => ({
  ...page.metadata,
  id: page.id,
  path: page.path,
  title: page.title,
  revision: page.revision,
  aliases: page.aliases,
  tags: page.tags,
  sources: page.sources,
  citations: page.citations,
  relationships: page.relationships
})

export const serializeMemoryMarkdown = (page: MemoryPage): string =>
  serializeFrontmatter(pageFrontmatter(page), page.body)

const maskInlineCode = (line: string): string => {
  const characters = [...line]
  let index = 0
  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1
      continue
    }
    let ticks = 1
    while (characters[index + ticks] === "`") ticks += 1
    let closing = index + ticks
    while (closing < characters.length) {
      let matched = true
      for (let offset = 0; offset < ticks; offset += 1) {
        if (characters[closing + offset] !== "`") matched = false
      }
      if (matched) break
      closing += 1
    }
    const end = closing < characters.length ? closing + ticks : characters.length
    for (let masked = index; masked < end; masked += 1) characters[masked] = " "
    index = end
  }
  return characters.join("")
}

const markdownLinesOutsideCode = (
  markdown: string
): Array<{ readonly text: string; readonly line: number }> => {
  const result: Array<{ readonly text: string; readonly line: number }> = []
  let fence: string | undefined
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0]!
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      continue
    }
    if (fence === undefined) result.push({ text: maskInlineCode(line), line: index + 1 })
  }
  return result
}

const parseWikiLinkContents = (
  rawContents: string
): { readonly target: string; readonly anchor?: string; readonly label?: string } | undefined => {
  const pipe = rawContents.indexOf("|")
  const destination = (pipe < 0 ? rawContents : rawContents.slice(0, pipe)).trim()
  const label = pipe < 0 ? undefined : rawContents.slice(pipe + 1).trim() || undefined
  const hash = destination.indexOf("#")
  const target = (hash < 0 ? destination : destination.slice(0, hash)).trim()
  const anchor = hash < 0 ? undefined : destination.slice(hash + 1).trim() || undefined
  if (target === "" && anchor === undefined) return undefined
  return { target, ...(anchor === undefined ? {} : { anchor }), ...(label === undefined ? {} : { label }) }
}

/** Extract unescaped wikilinks, excluding fenced and inline code. */
export const extractWikiLinks = (markdown: string): Array<WikiLink> => {
  const links: Array<WikiLink> = []
  for (const { text: line, line: lineNumber } of markdownLinesOutsideCode(markdown)) {
    let cursor = 0
    while (cursor < line.length - 1) {
      const start = line.indexOf("[[", cursor)
      if (start < 0) break
      if (start > 0 && line[start - 1] === "\\") {
        cursor = start + 2
        continue
      }
      const end = line.indexOf("]]", start + 2)
      if (end < 0) break
      const parsed = parseWikiLinkContents(line.slice(start + 2, end))
      if (parsed !== undefined) {
        links.push({
          raw: line.slice(start, end + 2),
          ...parsed,
          line: lineNumber,
          column: start + 1
        })
      }
      cursor = end + 2
    }
  }
  return links
}

export const parseWikilinks = extractWikiLinks
export const parseWikiLinks = extractWikiLinks

const CITATION_PATTERNS = [
  /\[\^([^\]\s]+)\](?!:)/g,
  /\{\{cite:([A-Za-z0-9_.:/-]+)\}\}/g,
  /<!--\s*cite:\s*([A-Za-z0-9_.:/-]+)\s*-->/g
]
const PANDOC_CITATION_BLOCK = /\[([^\]]*@[A-Za-z0-9_.:/-]+[^\]]*)\]/g
const PANDOC_CITATION_ID = /@([A-Za-z0-9_.:/-]+)/g

export const extractCitationReferences = (markdown: string): Array<CitationReference> => {
  const references: Array<CitationReference> = []
  for (const { text: line, line: lineNumber } of markdownLinesOutsideCode(markdown)) {
    for (const pattern of CITATION_PATTERNS) {
      pattern.lastIndex = 0
      let match = pattern.exec(line)
      while (match !== null) {
        if (match[1]) {
          references.push({ id: match[1], raw: match[0], line: lineNumber, column: match.index + 1 })
        }
        match = pattern.exec(line)
      }
    }
    PANDOC_CITATION_BLOCK.lastIndex = 0
    let block = PANDOC_CITATION_BLOCK.exec(line)
    while (block !== null) {
      PANDOC_CITATION_ID.lastIndex = 0
      let citation = PANDOC_CITATION_ID.exec(block[1] ?? "")
      while (citation !== null) {
        if (citation[1]) {
          references.push({
            id: citation[1],
            raw: citation[0],
            line: lineNumber,
            column: block.index + citation.index + 2
          })
        }
        citation = PANDOC_CITATION_ID.exec(block[1] ?? "")
      }
      block = PANDOC_CITATION_BLOCK.exec(line)
    }
  }
  return references.sort((left, right) => left.line - right.line || left.column - right.column)
}

export const extractCitationDefinitions = (markdown: string): ReadonlySet<string> => {
  const definitions = new Set<string>()
  for (const { text } of markdownLinesOutsideCode(markdown)) {
    const match = /^\s*\[\^([^\]\s]+)\]:\s+/.exec(text)
    if (match?.[1]) definitions.add(match[1])
  }
  return definitions
}

const claimText = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+] |\d+[.)] |>\s*)/, "")
    .trim()

const isClaimLine = (line: string): boolean => {
  const trimmed = line.trim()
  if (trimmed === "" || /^#{1,6}\s/.test(trimmed)) return false
  if (/^\[\^[^\]]+\]:/.test(trimmed)) return false
  if (/^(?:---+|___+|\*\*\*+)$/.test(trimmed)) return false
  if (/^<!--.*-->$/.test(trimmed)) return false
  if (/^\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) return false
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(trimmed)) return false
  return /[\p{L}\p{N}]/u.test(claimText(trimmed))
}

/**
 * A claim is a contiguous prose/list/quote paragraph outside code. Headings,
 * link definitions, thematic breaks and standalone media are not claims.
 */
export const extractMarkdownClaims = (markdown: string): Array<MarkdownClaim> => {
  const claims: Array<MarkdownClaim> = []
  let paragraph: Array<{ readonly text: string; readonly line: number }> = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.map((entry) => claimText(entry.text)).join(" ").trim()
    const references = extractCitationReferences(text).map((reference) => reference.id)
    claims.push({ text, citationIds: [...new Set(references)], line: paragraph[0]!.line })
    paragraph = []
  }
  for (const line of markdownLinesOutsideCode(markdown)) {
    if (!isClaimLine(line.text)) {
      flush()
      continue
    }
    paragraph.push(line)
  }
  flush()
  return claims
}

export const slugifyMarkdownHeading = (heading: string): string =>
  heading
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

export const extractMarkdownHeadings = (markdown: string): ReadonlySet<string> => {
  const headings = new Set<string>()
  for (const { text } of markdownLinesOutsideCode(markdown)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text)
    if (match?.[1]) headings.add(slugifyMarkdownHeading(match[1]))
  }
  return headings
}

export const parseMarkdown = parseMemoryMarkdown
export const stringifyMarkdown = serializeMemoryMarkdown
