import { Schema } from "effect"
import { buildMemoryAnalytics, type MemoryAnalyticsSummary } from "./analytics.js"
import {
  extractCitationReferences,
  extractWikiLinks,
  serializeMemoryMarkdown
} from "./markdown.js"
import {
  MemoryRelationship,
  MemorySourceKind,
  type MemoryAuditEvent,
  type MemoryPage,
  type MemorySource
} from "./model.js"

export const MemoryPageGraphNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("page"),
  pageId: Schema.String,
  path: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String)
})
export type MemoryPageGraphNode = Schema.Schema.Type<typeof MemoryPageGraphNode>

export const MemorySourceGraphNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("source"),
  sourceId: Schema.String,
  sourceKind: MemorySourceKind,
  title: Schema.String
})
export type MemorySourceGraphNode = Schema.Schema.Type<typeof MemorySourceGraphNode>

export const MemorySchemaGraphNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("schema"),
  schemaId: Schema.String,
  title: Schema.String
})
export type MemorySchemaGraphNode = Schema.Schema.Type<typeof MemorySchemaGraphNode>

export const MemoryGraphNode = Schema.Union(
  MemoryPageGraphNode,
  MemorySourceGraphNode,
  MemorySchemaGraphNode
)
export type MemoryGraphNode = Schema.Schema.Type<typeof MemoryGraphNode>

export const MemoryGraphEdgeKind = Schema.Literal(
  "wikilink",
  "citation",
  "dependency",
  "backlink",
  "schema"
)
export type MemoryGraphEdgeKind = Schema.Schema.Type<typeof MemoryGraphEdgeKind>

export const MemoryWikilinkEvidence = Schema.Struct({
  kind: Schema.Literal("wikilink"),
  pageId: Schema.String,
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  raw: Schema.String
})
export type MemoryWikilinkEvidence = Schema.Schema.Type<typeof MemoryWikilinkEvidence>

export const MemoryCitationEvidence = Schema.Struct({
  kind: Schema.Literal("citation"),
  pageId: Schema.String,
  path: Schema.String,
  citationId: Schema.String,
  sourceId: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  raw: Schema.String
})
export type MemoryCitationEvidence = Schema.Schema.Type<typeof MemoryCitationEvidence>

export const MemoryDependencyEvidence = Schema.Struct({
  kind: Schema.Literal("dependency"),
  pageId: Schema.String,
  path: Schema.String,
  relationshipIndex: Schema.Number,
  target: Schema.String,
  label: Schema.optional(Schema.String)
})
export type MemoryDependencyEvidence = Schema.Schema.Type<typeof MemoryDependencyEvidence>

export const MemoryBacklinkEvidence = Schema.Struct({
  kind: Schema.Literal("backlink"),
  sourcePageId: Schema.String,
  targetPageId: Schema.String,
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  raw: Schema.String
})
export type MemoryBacklinkEvidence = Schema.Schema.Type<typeof MemoryBacklinkEvidence>

export const MemorySchemaEvidence = Schema.Struct({
  kind: Schema.Literal("schema"),
  pageId: Schema.String,
  path: Schema.String,
  relationshipIndex: Schema.Number,
  target: Schema.String,
  label: Schema.optional(Schema.String)
})
export type MemorySchemaEvidence = Schema.Schema.Type<typeof MemorySchemaEvidence>

export const MemoryGraphEvidence = Schema.Union(
  MemoryWikilinkEvidence,
  MemoryCitationEvidence,
  MemoryDependencyEvidence,
  MemoryBacklinkEvidence,
  MemorySchemaEvidence
)
export type MemoryGraphEvidence = Schema.Schema.Type<typeof MemoryGraphEvidence>

export const MemoryGraphEdge = Schema.Struct({
  sourceId: Schema.String,
  targetId: Schema.String,
  kind: MemoryGraphEdgeKind,
  evidence: MemoryGraphEvidence
}).pipe(
  Schema.filter((edge) =>
    edge.kind === edge.evidence.kind ? true : "graph edge kind must match its evidence kind"
  )
)
export type MemoryGraphEdge = Schema.Schema.Type<typeof MemoryGraphEdge>

export const MemoryGraph = Schema.Struct({
  version: Schema.Literal(1),
  nodes: Schema.Array(MemoryGraphNode),
  edges: Schema.Array(MemoryGraphEdge)
}).pipe(
  Schema.filter((graph) => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node.kind]))
    if (nodes.size !== graph.nodes.length) return "graph node ids must be unique"
    for (const edge of graph.edges) {
      const sourceKind = nodes.get(edge.sourceId)
      const targetKind = nodes.get(edge.targetId)
      if (sourceKind === undefined || targetKind === undefined) {
        return "graph edges must resolve to declared nodes"
      }
      if (sourceKind !== "page") return "graph edges must originate at page nodes"
      if (edge.kind === "citation" && targetKind !== "source") {
        return "citation edges must target source nodes"
      }
      if (edge.kind === "schema" && targetKind !== "schema") {
        return "schema edges must target schema nodes"
      }
      if (
        (edge.kind === "wikilink" || edge.kind === "dependency" || edge.kind === "backlink") &&
        targetKind !== "page"
      ) {
        return `${edge.kind} edges must target page nodes`
      }
    }
    return true
  })
)
export type MemoryGraph = Schema.Schema.Type<typeof MemoryGraph>

export const MemoryGraphManifest = MemoryGraph
export type MemoryGraphManifest = MemoryGraph

export const MemoryIndexEntry = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  title: Schema.String,
  revision: Schema.Number,
  aliases: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String)
})
export type MemoryIndexEntry = Schema.Schema.Type<typeof MemoryIndexEntry>

export const MemoryIndex = Schema.Struct({
  version: Schema.Literal(1),
  pages: Schema.Array(MemoryIndexEntry)
})
export type MemoryIndex = Schema.Schema.Type<typeof MemoryIndex>

export const MemoryExportPage = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  revision: Schema.Number,
  contentHash: Schema.String,
  links: Schema.Array(Schema.String),
  citations: Schema.Array(Schema.String),
  relationships: Schema.Array(MemoryRelationship)
})
export type MemoryExportPage = Schema.Schema.Type<typeof MemoryExportPage>

export const MemoryExportSource = Schema.Struct({
  id: Schema.String,
  contentHash: Schema.optional(Schema.String)
})
export type MemoryExportSource = Schema.Schema.Type<typeof MemoryExportSource>

export const MemoryExportManifest = Schema.Struct({
  version: Schema.Literal(1),
  pages: Schema.Array(MemoryExportPage),
  sources: Schema.Array(MemoryExportSource),
  indexHash: Schema.String,
  graphHash: Schema.String,
  analyticsHash: Schema.String
})
export type MemoryExportManifest = Schema.Schema.Type<typeof MemoryExportManifest>

export interface MemoryDerivedArtifacts {
  readonly index: MemoryIndex
  readonly backlinks: Readonly<Record<string, ReadonlyArray<string>>>
  readonly graph: MemoryGraph
  readonly analytics: MemoryAnalyticsSummary
  readonly manifest: MemoryExportManifest
}

export class MemoryGraphError extends Error {
  override readonly name = "MemoryGraphError"
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const sortedUnique = (values: Iterable<string>): Array<string> =>
  [...new Set(values)].sort(compareText)

const withoutMarkdownExtension = (value: string): string => value.replace(/\.md$/i, "")

export const memoryPageNodeId = (pageId: string): string => `page:${pageId}`
export const memorySourceNodeId = (sourceId: string): string => `source:${sourceId}`
export const memorySchemaNodeId = (schemaId: string): string => `schema:${schemaId}`

/** Case-insensitive canonical key shared by link resolution and duplicate checks. */
export const normalizeMemoryIdentity = (value: string): string => {
  let decoded = value.trim()
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // An invalid percent escape cannot accidentally resolve to another page.
  }
  return withoutMarkdownExtension(decoded.replace(/^\.\//, "").replace(/\\/g, "/"))
    .replace(/\/{2,}/g, "/")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US")
}

export const identitiesForPage = (page: MemoryPage): ReadonlyArray<string> => {
  const pathWithoutExtension = withoutMarkdownExtension(page.path)
  const filename = pathWithoutExtension.slice(pathWithoutExtension.lastIndexOf("/") + 1)
  return sortedUnique(
    [page.id, page.path, pathWithoutExtension, filename, page.title, ...page.aliases].map(
      normalizeMemoryIdentity
    )
  ).filter((identity) => identity !== "")
}

export const buildIdentityIndex = (
  pages: ReadonlyArray<MemoryPage>
): ReadonlyMap<string, ReadonlyArray<MemoryPage>> => {
  const mutable = new Map<string, Array<MemoryPage>>()
  for (const page of pages) {
    for (const identity of identitiesForPage(page)) {
      const matches = mutable.get(identity) ?? []
      matches.push(page)
      mutable.set(identity, matches)
    }
  }
  return new Map(
    [...mutable.entries()].map(([identity, matches]) => [
      identity,
      [...matches].sort((left, right) => compareText(left.path, right.path))
    ])
  )
}

export const resolveWikiLink = (
  target: string,
  pagesOrIndex: ReadonlyArray<MemoryPage> | ReadonlyMap<string, ReadonlyArray<MemoryPage>>
): MemoryPage | undefined => {
  const isPageArray = (
    value: ReadonlyArray<MemoryPage> | ReadonlyMap<string, ReadonlyArray<MemoryPage>>
  ): value is ReadonlyArray<MemoryPage> => Array.isArray(value)
  const index = isPageArray(pagesOrIndex) ? buildIdentityIndex(pagesOrIndex) : pagesOrIndex
  const matches = index.get(normalizeMemoryIdentity(target))
  return matches?.length === 1 ? matches[0] : undefined
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child)])
    )
  }
  return value
}

export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(canonicalValue(value), null, 2)}\n`

const utf8Bytes = (value: string): Array<number> => {
  const bytes: Array<number> = []
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point <= 0x7f) bytes.push(point)
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      )
    }
  }
  return bytes
}

/** Stable non-cryptographic content identifier for reproducible artifacts. */
export const stableContentHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of utf8Bytes(value)) hash = ((hash ^ BigInt(byte)) * prime) & mask
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`
}

export const buildMemoryIndex = (pages: ReadonlyArray<MemoryPage>): MemoryIndex => ({
  version: 1,
  pages: [...pages]
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id))
    .map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      revision: page.revision,
      aliases: sortedUnique(page.aliases),
      tags: sortedUnique(page.tags)
    }))
})

const uniqueSources = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource>
): Array<MemorySource> => {
  const candidates = new Map<string, Array<MemorySource>>()
  for (const source of repositorySources) {
    const values = candidates.get(source.id) ?? []
    values.push(source)
    candidates.set(source.id, values)
  }
  for (const page of pages) {
    for (const source of page.sources) {
      const values = candidates.get(source.id) ?? []
      values.push(source)
      candidates.set(source.id, values)
    }
  }
  return [...candidates.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, values]) =>
      [...values].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))[0]!
    )
}

const resolvePageRelationship = (
  page: MemoryPage,
  target: string,
  identities: ReadonlyMap<string, ReadonlyArray<MemoryPage>>
): MemoryPage => {
  const matches = identities.get(normalizeMemoryIdentity(target)) ?? []
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "does not resolve" : "is ambiguous"
    throw new MemoryGraphError(`${page.path} relationship "${target}" ${reason}`)
  }
  return matches[0]!
}

const addWikilinkEdges = (
  page: MemoryPage,
  identities: ReadonlyMap<string, ReadonlyArray<MemoryPage>>,
  edges: Map<string, MemoryGraphEdge>
): void => {
  for (const link of extractWikiLinks(page.body)) {
    const target =
      link.target === "" ? page : resolvePageRelationship(page, link.target, identities)
    const forward: MemoryGraphEdge = {
      sourceId: memoryPageNodeId(page.id),
      targetId: memoryPageNodeId(target.id),
      kind: "wikilink",
      evidence: {
        kind: "wikilink",
        pageId: page.id,
        path: page.path,
        line: link.line,
        column: link.column,
        raw: link.raw
      }
    }
    const backlink: MemoryGraphEdge = {
      sourceId: memoryPageNodeId(target.id),
      targetId: memoryPageNodeId(page.id),
      kind: "backlink",
      evidence: {
        kind: "backlink",
        sourcePageId: page.id,
        targetPageId: target.id,
        path: page.path,
        line: link.line,
        column: link.column,
        raw: link.raw
      }
    }
    edges.set(canonicalJson(forward), forward)
    edges.set(canonicalJson(backlink), backlink)
  }
}

const addCitationEdges = (
  page: MemoryPage,
  sources: ReadonlyMap<string, MemorySource>,
  edges: Map<string, MemoryGraphEdge>
): void => {
  const citations = new Map(page.citations.map((citation) => [citation.id, citation]))
  for (const reference of extractCitationReferences(page.body)) {
    const citation = citations.get(reference.id)
    const sourceId = citation?.sourceId ?? (sources.has(reference.id) ? reference.id : undefined)
    if (sourceId === undefined || !sources.has(sourceId)) continue
    const edge: MemoryGraphEdge = {
      sourceId: memoryPageNodeId(page.id),
      targetId: memorySourceNodeId(sourceId),
      kind: "citation",
      evidence: {
        kind: "citation",
        pageId: page.id,
        path: page.path,
        citationId: reference.id,
        sourceId,
        line: reference.line,
        column: reference.column,
        raw: reference.raw
      }
    }
    edges.set(canonicalJson(edge), edge)
  }
}

const addRelationshipEdges = (
  page: MemoryPage,
  identities: ReadonlyMap<string, ReadonlyArray<MemoryPage>>,
  nodes: Map<string, MemoryGraphNode>,
  edges: Map<string, MemoryGraphEdge>
): void => {
  for (let index = 0; index < page.relationships.length; index += 1) {
    const relationship = page.relationships[index]!
    if (relationship.kind === "dependency") {
      const target = resolvePageRelationship(page, relationship.target, identities)
      const edge: MemoryGraphEdge = {
        sourceId: memoryPageNodeId(page.id),
        targetId: memoryPageNodeId(target.id),
        kind: "dependency",
        evidence: {
          kind: "dependency",
          pageId: page.id,
          path: page.path,
          relationshipIndex: index,
          target: relationship.target,
          ...(relationship.label === undefined ? {} : { label: relationship.label })
        }
      }
      edges.set(canonicalJson(edge), edge)
      continue
    }
    const nodeId = memorySchemaNodeId(relationship.target)
    nodes.set(nodeId, {
      id: nodeId,
      kind: "schema",
      schemaId: relationship.target,
      title: relationship.label ?? relationship.target
    })
    const edge: MemoryGraphEdge = {
      sourceId: memoryPageNodeId(page.id),
      targetId: nodeId,
      kind: "schema",
      evidence: {
        kind: "schema",
        pageId: page.id,
        path: page.path,
        relationshipIndex: index,
        target: relationship.target,
        ...(relationship.label === undefined ? {} : { label: relationship.label })
      }
    }
    edges.set(canonicalJson(edge), edge)
  }
}

export const buildMemoryGraph = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource> = []
): MemoryGraph => {
  const identities = buildIdentityIndex(pages)
  const sourceList = uniqueSources(pages, repositorySources)
  const sources = new Map(sourceList.map((source) => [source.id, source]))
  const nodes = new Map<string, MemoryGraphNode>()
  const edges = new Map<string, MemoryGraphEdge>()
  for (const page of pages) {
    const nodeId = memoryPageNodeId(page.id)
    nodes.set(nodeId, {
      id: nodeId,
      kind: "page",
      pageId: page.id,
      path: page.path,
      title: page.title,
      tags: sortedUnique(page.tags)
    })
  }
  for (const source of sourceList) {
    const nodeId = memorySourceNodeId(source.id)
    nodes.set(nodeId, {
      id: nodeId,
      kind: "source",
      sourceId: source.id,
      sourceKind: source.kind,
      title: source.title
    })
  }
  for (const page of pages) {
    addWikilinkEdges(page, identities, edges)
    addCitationEdges(page, sources, edges)
    addRelationshipEdges(page, identities, nodes, edges)
  }
  return {
    version: 1,
    nodes: [...nodes.values()].sort((left, right) => compareText(left.id, right.id)),
    edges: [...edges.values()].sort(
      (left, right) =>
        compareText(left.sourceId, right.sourceId) ||
        compareText(left.targetId, right.targetId) ||
        compareText(left.kind, right.kind) ||
        compareText(canonicalJson(left.evidence), canonicalJson(right.evidence))
    )
  }
}

/** Re-derive the graph to prove that no persisted edge lacks accepted page evidence. */
export const assertMemoryGraphEvidence = (
  graph: MemoryGraph,
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource> = []
): void => {
  const expected = buildMemoryGraph(pages, repositorySources)
  if (canonicalJson(graph) !== canonicalJson(expected)) {
    throw new MemoryGraphError("graph does not match the accepted memory evidence")
  }
}

export const graphMatchesMemoryEvidence = (
  graph: MemoryGraph,
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource> = []
): boolean => {
  try {
    assertMemoryGraphEvidence(graph, pages, repositorySources)
    return true
  } catch {
    return false
  }
}

export const buildBacklinkIndex = (
  pages: ReadonlyArray<MemoryPage>
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const identities = buildIdentityIndex(pages)
  const backlinks = new Map<string, Set<string>>(pages.map((page) => [page.id, new Set()]))
  for (const page of pages) {
    for (const link of extractWikiLinks(page.body)) {
      const target = link.target === "" ? page : resolveWikiLink(link.target, identities)
      if (target !== undefined) {
        backlinks.get(target.id)?.add(page.id)
      }
    }
  }
  return Object.fromEntries(
    [...backlinks.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, sources]) => [id, sortedUnique(sources)])
  )
}

const buildExportManifestFromArtifacts = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource>,
  index: MemoryIndex,
  graph: MemoryGraph,
  analytics: MemoryAnalyticsSummary
): MemoryExportManifest => {
  const identities = buildIdentityIndex(pages)
  return {
    version: 1,
    pages: [...pages]
      .sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id))
      .map((page) => ({
        id: page.id,
        path: page.path,
        revision: page.revision,
        contentHash: stableContentHash(serializeMemoryMarkdown(page)),
        links: sortedUnique(
          extractWikiLinks(page.body).map((link) => {
            const target =
              link.target === "" ? page : resolvePageRelationship(page, link.target, identities)
            return target.id
          })
        ),
        citations: sortedUnique(page.citations.map((citation) => citation.id)),
        relationships: page.relationships
      })),
    sources: uniqueSources(pages, repositorySources).map((source) => ({
      id: source.id,
      ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash })
    })),
    indexHash: stableContentHash(canonicalJson(index)),
    graphHash: stableContentHash(canonicalJson(graph)),
    analyticsHash: stableContentHash(canonicalJson(analytics))
  }
}

export const buildExportManifest = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource> = [],
  auditEvents: ReadonlyArray<MemoryAuditEvent> = []
): MemoryExportManifest =>
  buildExportManifestFromArtifacts(
    pages,
    repositorySources,
    buildMemoryIndex(pages),
    buildMemoryGraph(pages, repositorySources),
    buildMemoryAnalytics(pages, auditEvents)
  )

export const buildMemoryArtifacts = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource> = [],
  auditEvents: ReadonlyArray<MemoryAuditEvent> = []
): MemoryDerivedArtifacts => {
  const index = buildMemoryIndex(pages)
  const graph = buildMemoryGraph(pages, repositorySources)
  const analytics = buildMemoryAnalytics(pages, auditEvents)
  const manifest = buildExportManifestFromArtifacts(
    pages,
    repositorySources,
    index,
    graph,
    analytics
  )
  return {
    index,
    backlinks: buildBacklinkIndex(pages),
    graph,
    analytics,
    manifest
  }
}

export const serializeMemoryGraph = (graph: MemoryGraph): string => canonicalJson(graph)
export const serializeMemoryIndex = (index: MemoryIndex): string => canonicalJson(index)
export const serializeExportManifest = (manifest: MemoryExportManifest): string =>
  canonicalJson(manifest)

const parseJson = (value: string, artifact: string): unknown => {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new MemoryGraphError(`invalid ${artifact} JSON: ${String(error)}`)
  }
}

export const parseMemoryGraph = (value: string): MemoryGraph =>
  Schema.decodeUnknownSync(MemoryGraph)(parseJson(value, "memory graph"))

export const parseMemoryIndex = (value: string): MemoryIndex =>
  Schema.decodeUnknownSync(MemoryIndex)(parseJson(value, "memory index"))

export const parseExportManifest = (value: string): MemoryExportManifest =>
  Schema.decodeUnknownSync(MemoryExportManifest)(parseJson(value, "memory export manifest"))
