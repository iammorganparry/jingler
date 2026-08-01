import {
  buildMemoryGraph,
  canonicalJson,
  stableContentHash,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphEvidence,
  type MemoryGraphNode,
  type MemoryPage,
  type MemorySource
} from "@jingler/memory"

export const DEFAULT_GRAPH_NODE_LIMIT = 200
export const MAX_GRAPH_NODE_LIMIT = 500
export const MAX_TOPIC_CLUSTERS = 50
export const MAX_TOPIC_SAMPLES = 10
export const DEFAULT_NEIGHBORHOOD_LIMIT = 50
export const MAX_NEIGHBORHOOD_LIMIT = 100

export interface VaultGraphHealth {
  readonly brokenLinks: number
  readonly contradictions: number
  readonly orphan: boolean
}

export interface VaultGraphNode {
  readonly id: string
  readonly kind: MemoryGraphNode["kind"]
  readonly title: string
  readonly pageId?: string
  readonly sourceId?: string
  readonly schemaId?: string
  readonly topicId?: string
  readonly degree: { readonly incoming: number; readonly outgoing: number }
  readonly freshness: "fresh" | "aging" | "stale" | "unknown"
  readonly health: VaultGraphHealth
}

export interface VaultGraphEdge {
  readonly id: string
  readonly sourceId: string
  readonly targetId: string
  readonly kind: MemoryGraphEdge["kind"]
}

export interface VaultTopicCluster {
  readonly id: string
  readonly label: string
  readonly nodeCount: number
  readonly sampleNodeIds: ReadonlyArray<string>
}

export interface VaultGraphView {
  readonly version: 1
  readonly totalNodes: number
  readonly totalEdges: number
  readonly nodes: ReadonlyArray<VaultGraphNode>
  readonly edges: ReadonlyArray<VaultGraphEdge>
  readonly clusters: ReadonlyArray<VaultTopicCluster>
  readonly truncated: boolean
  readonly nextCursor?: string
}

export interface VaultGraphEvidenceResponse {
  readonly edge: VaultGraphEdge
  readonly evidence: MemoryGraphEvidence
}

export interface GraphBuildContext {
  readonly acceptedAtByPageId?: ReadonlyMap<string, string>
  readonly now?: string
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const edgeId = (edge: MemoryGraphEdge): string => stableContentHash(canonicalJson(edge))

const boundedLimit = (requested: number | undefined, fallback: number, maximum: number): number => {
  if (requested === undefined || !Number.isFinite(requested)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(requested)))
}

const ageStatus = (acceptedAt: string | undefined, now: string | undefined): VaultGraphNode["freshness"] => {
  if (acceptedAt === undefined || now === undefined) return "unknown"
  const age = Date.parse(now) - Date.parse(acceptedAt)
  if (!Number.isFinite(age)) return "unknown"
  const days = age / 86_400_000
  return days <= 30 ? "fresh" : days <= 90 ? "aging" : "stale"
}

const contradictionCount = (page: MemoryPage | undefined): number => {
  if (page === undefined) return 0
  const contradictions = page.metadata.contradictions
  if (Array.isArray(contradictions)) return contradictions.length
  return typeof contradictions === "number" && contradictions > 0 ? Math.floor(contradictions) : 0
}

const graphDegrees = (
  graph: MemoryGraph
): ReadonlyMap<string, { readonly incoming: number; readonly outgoing: number }> => {
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of graph.edges) {
    outgoing.set(edge.sourceId, (outgoing.get(edge.sourceId) ?? 0) + 1)
    incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1)
  }
  return new Map(
    graph.nodes.map((node) => [
      node.id,
      { incoming: incoming.get(node.id) ?? 0, outgoing: outgoing.get(node.id) ?? 0 }
    ])
  )
}

const titleForNode = (node: MemoryGraphNode): string => node.title

const compactNode = (
  node: MemoryGraphNode,
  pages: ReadonlyMap<string, MemoryPage>,
  degrees: ReadonlyMap<string, { readonly incoming: number; readonly outgoing: number }>,
  context: GraphBuildContext
): VaultGraphNode => {
  const page = node.kind === "page" ? pages.get(node.pageId) : undefined
  const degree = degrees.get(node.id) ?? { incoming: 0, outgoing: 0 }
  const topic = page?.tags[0]?.trim()
  return {
    id: node.id,
    kind: node.kind,
    title: titleForNode(node),
    ...(node.kind === "page" ? { pageId: node.pageId } : {}),
    ...(node.kind === "source" ? { sourceId: node.sourceId } : {}),
    ...(node.kind === "schema" ? { schemaId: node.schemaId } : {}),
    ...(topic === undefined || topic === "" ? {} : { topicId: `topic:${normalizeTopic(topic)}` }),
    degree,
    freshness: ageStatus(
      node.kind === "page" ? context.acceptedAtByPageId?.get(node.pageId) : undefined,
      context.now
    ),
    health: {
      brokenLinks: 0,
      contradictions: contradictionCount(page),
      orphan: node.kind === "page" && degree.incoming + degree.outgoing === 0
    }
  }
}

const compactEdge = (edge: MemoryGraphEdge): VaultGraphEdge => ({
  id: edgeId(edge),
  sourceId: edge.sourceId,
  targetId: edge.targetId,
  kind: edge.kind
})

const normalizeTopic = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "uncategorized"

const clustersFor = (pages: ReadonlyArray<MemoryPage>): ReadonlyArray<VaultTopicCluster> => {
  const groups = new Map<string, { label: string; nodeIds: Array<string> }>()
  for (const page of pages) {
    const label = page.tags[0]?.trim() || "Uncategorized"
    const id = `topic:${normalizeTopic(label)}`
    const group = groups.get(id) ?? { label, nodeIds: [] }
    group.nodeIds.push(`page:${page.id}`)
    groups.set(id, group)
  }
  const ranked = [...groups.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      right.nodeIds.length - left.nodeIds.length || compareText(leftId, rightId)
  )
  const visible = ranked.slice(0, MAX_TOPIC_CLUSTERS)
  const hidden = ranked.slice(MAX_TOPIC_CLUSTERS)
  const clusters = visible.map(([id, group]) => ({
    id,
    label: group.label,
    nodeCount: group.nodeIds.length,
    sampleNodeIds: group.nodeIds.sort(compareText).slice(0, MAX_TOPIC_SAMPLES)
  }))
  if (hidden.length > 0) {
    const hiddenNodeIds = hidden.flatMap(([, group]) => group.nodeIds).sort(compareText)
    const lastVisible = clusters.at(-1)
    if (lastVisible !== undefined) clusters.pop()
    clusters.push({
      id: "topic:other",
      label: "Other",
      nodeCount: hiddenNodeIds.length + (lastVisible?.nodeCount ?? 0),
      sampleNodeIds: [...(lastVisible?.sampleNodeIds ?? []), ...hiddenNodeIds]
        .sort(compareText)
        .slice(0, MAX_TOPIC_SAMPLES)
    })
  }
  return clusters.sort((left, right) => compareText(left.id, right.id))
}

const graphContext = (
  pages: ReadonlyArray<MemoryPage>,
  sources: ReadonlyArray<MemorySource>,
  context: GraphBuildContext
): {
  readonly graph: MemoryGraph
  readonly pages: ReadonlyMap<string, MemoryPage>
  readonly degrees: ReadonlyMap<string, { readonly incoming: number; readonly outgoing: number }>
  readonly context: GraphBuildContext
} => {
  const graph = buildMemoryGraph(pages, sources)
  return {
    graph,
    pages: new Map(pages.map((page) => [page.id, page])),
    degrees: graphDegrees(graph),
    context
  }
}

export const buildBoundedGraphView = (
  pages: ReadonlyArray<MemoryPage>,
  sources: ReadonlyArray<MemorySource> = [],
  options: { readonly limit?: number; readonly cursor?: number } = {},
  context: GraphBuildContext = {}
): VaultGraphView => {
  const built = graphContext(pages, sources, context)
  const limit = boundedLimit(options.limit, DEFAULT_GRAPH_NODE_LIMIT, MAX_GRAPH_NODE_LIMIT)
  const cursor = Math.max(0, Math.floor(options.cursor ?? 0))
  const selected = built.graph.nodes.slice(cursor, cursor + limit)
  const selectedIds = new Set(selected.map((node) => node.id))
  const edges = built.graph.edges
    .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
    .slice(0, limit * 4)
    .map(compactEdge)
  const next = cursor + selected.length
  return {
    version: 1,
    totalNodes: built.graph.nodes.length,
    totalEdges: built.graph.edges.length,
    nodes: selected.map((node) => compactNode(node, built.pages, built.degrees, built.context)),
    edges,
    clusters: clustersFor(pages),
    truncated: next < built.graph.nodes.length,
    ...(next < built.graph.nodes.length ? { nextCursor: String(next) } : {})
  }
}

export const buildGraphNeighborhood = (
  pages: ReadonlyArray<MemoryPage>,
  sources: ReadonlyArray<MemorySource>,
  nodeId: string,
  requestedLimit?: number,
  context: GraphBuildContext = {}
): VaultGraphView => {
  const built = graphContext(pages, sources, context)
  if (!built.graph.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`graph node ${nodeId} was not found`)
  }
  const limit = boundedLimit(requestedLimit, DEFAULT_NEIGHBORHOOD_LIMIT, MAX_NEIGHBORHOOD_LIMIT)
  const incident = built.graph.edges.filter(
    (edge) => edge.sourceId === nodeId || edge.targetId === nodeId
  )
  const neighborIds = new Set<string>([nodeId])
  for (const edge of incident) {
    if (neighborIds.size >= limit) break
    neighborIds.add(edge.sourceId === nodeId ? edge.targetId : edge.sourceId)
  }
  const nodes = built.graph.nodes.filter((node) => neighborIds.has(node.id))
  const edges = incident
    .filter((edge) => neighborIds.has(edge.sourceId) && neighborIds.has(edge.targetId))
    .slice(0, limit * 4)
  return {
    version: 1,
    totalNodes: built.graph.nodes.length,
    totalEdges: built.graph.edges.length,
    nodes: nodes.map((node) => compactNode(node, built.pages, built.degrees, built.context)),
    edges: edges.map(compactEdge),
    clusters: clustersFor(
      pages.filter((page) => neighborIds.has(`page:${page.id}`))
    ),
    truncated: nodes.length < built.graph.nodes.length
  }
}

export const findGraphEdgeEvidence = (
  pages: ReadonlyArray<MemoryPage>,
  sources: ReadonlyArray<MemorySource>,
  requestedEdgeId: string
): VaultGraphEvidenceResponse | undefined => {
  const edge = buildMemoryGraph(pages, sources).edges.find(
    (candidate) => edgeId(candidate) === requestedEdgeId
  )
  return edge === undefined ? undefined : { edge: compactEdge(edge), evidence: edge.evidence }
}
