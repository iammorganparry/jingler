import type {
  MemoryAccess,
  MemoryDashboardSummary,
  MemoryGraphNode,
  MemoryGraphView,
  MemoryPageDetail
} from "@jingler/contracts"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import {
  createMemoryMachine,
  DEFAULT_MEMORY_FILTERS,
  DEFAULT_MEMORY_VIEWPORT,
  type MemoryApi
} from "./memory-machine.js"
import { computeMemoryLayout } from "./memory-layout.worker.js"

const access: MemoryAccess = {
  eligible: true,
  selectedOrganizationId: "org-a",
  organizations: [
    { id: "org-a", name: "Alpha", role: "owner", privileges: ["read", "propose", "review", "schema"] },
    { id: "org-b", name: "Beta", role: "admin", privileges: ["read", "propose", "review"] }
  ]
}

const summary = (organizationId: string): MemoryDashboardSummary => ({
  version: 1,
  asOf: `2026-08-01T00:00:00.000Z#${organizationId}`,
  growth: { acceptedPages: 2, revisions: 3, sources: 2, daily: [] },
  citationCoverage: { citations: 2, citedPages: 2, totalPages: 2, ratio: 1 },
  freshness: { fresh: 2, aging: 0, stale: 0, unknown: 0 },
  health: { orphanPages: 0, brokenLinks: 0, contradictions: 0 },
  reviewThroughput: { proposed: 1, accepted: 0, rejected: 0, conflicted: 0, open: 1, acceptanceRatio: 0, medianReviewHours: null },
  connectivity: { pages: 2, directedLinks: 1, connectedPages: 2, averageDegree: 1 },
  retrieval: {
    searches: 1,
    reads: 1,
    navigation: 0,
    graphReads: 0,
    proposals: 0,
    zeroResultSearches: 0,
    zeroResultRatio: 0,
    resultsReturned: 2,
    uniqueQueryHashes: 1,
    medianDurationMs: 4,
    p95DurationMs: 4
  }
})

const graph = (organizationId: string): MemoryGraphView => ({
  version: 1,
  totalNodes: 10_000,
  totalEdges: 20_000,
  nodes: [
    { id: `page:${organizationId}:one`, kind: "page", title: `${organizationId} one`, pageId: `${organizationId}:one`, degree: { incoming: 1, outgoing: 1 }, freshness: "fresh", health: { brokenLinks: 0, contradictions: 0, orphan: false } },
    { id: `page:${organizationId}:two`, kind: "page", title: `${organizationId} two`, pageId: `${organizationId}:two`, degree: { incoming: 1, outgoing: 0 }, freshness: "fresh", health: { brokenLinks: 0, contradictions: 0, orphan: false } }
  ],
  edges: [{ id: `edge:${organizationId}`, sourceId: `page:${organizationId}:one`, targetId: `page:${organizationId}:two`, kind: "wikilink" }],
  clusters: [{ id: "topic:test", label: "Test", nodeCount: 10_000, sampleNodeIds: [`page:${organizationId}:one`] }],
  truncated: true,
  nextCursor: "2"
})

const page = (pageId: string): MemoryPageDetail => ({
  page: { id: pageId, path: `${pageId}.md`, title: pageId, revision: 2, aliases: [], tags: [], body: "Accepted prose", citations: [{ id: "citation:1", sourceId: "source:1" }] },
  revision: { id: `revision:${pageId}`, pageId, revision: 2, authorId: "author:1", createdAt: "2026-08-01T00:00:00.000Z", acceptedAt: "2026-08-01T00:00:00.000Z" },
  sourceIds: ["source:1"],
  citationIds: ["citation:1"],
  backlinks: ["page:other"],
  contributors: ["author:1"],
  health: { brokenLinks: 0, contradictions: 0, orphan: false }
})

const evidenceFixture: MemoryApi["evidence"] = async (organizationId, edgeId) => {
  const edge = graph(organizationId).edges[0]
  if (edge === undefined) throw new Error("edge fixture missing")
  return {
    edge,
    evidence: {
      kind: "wikilink",
      pageId: `${organizationId}:one`,
      path: "one.md",
      line: 4,
      column: 2,
      raw: `[[${edgeId}]]`
    }
  }
}

const api: MemoryApi = {
  access: vi.fn(async () => access),
  recover: vi.fn(async () => ({
    queuedBefore: 0,
    delivered: 0,
    retained: 0,
    discarded: 0,
    lastFailureStatus: null
  })),
  configure: vi.fn(async (organizationId: string) => ({
    ...access,
    selectedOrganizationId: organizationId
  })),
  dashboard: vi.fn(async (organizationId: string) => summary(organizationId)),
  graph: vi.fn(async (organizationId: string) => graph(organizationId)),
  neighborhood: vi.fn(async (organizationId: string) => graph(organizationId)),
  evidence: vi.fn(evidenceFixture),
  search: vi.fn(async (organizationId: string, query: string) => [
    {
      pageId: `${organizationId}:one`,
      path: `${organizationId}:one.md`,
      title: `${organizationId} ${query}`,
      revisionId: `revision:${organizationId}:one`,
      snippet: "Accepted result"
    }
  ]),
  page: vi.fn(async (_organizationId: string, pageId: string) => page(pageId)),
  export: vi.fn(async (organizationId: string) => ({ filename: `${organizationId}.zip`, saved: true })),
  suggestions: vi.fn(async () => ({ version: 1 as const, vectorSource: "lexical" as const, suggestions: [] }))
}

const startReady = async () => {
  const actor = createActor(createMemoryMachine(api)).start()
  await waitFor(actor, (snapshot) => snapshot.matches("closed"))
  actor.send({ type: "OPEN" })
  await waitFor(actor, (snapshot) => snapshot.matches("ready"))
  return actor
}

describe("memoryMachine", () => {
  it("clears every organization-owned record before loading the next organization", async () => {
    const actor = await startReady()
    actor.send({ type: "MAP.FILTERS", filters: { ...DEFAULT_MEMORY_FILTERS, query: "alpha", healthOnly: true } })
    actor.send({ type: "MAP.VIEWPORT", viewport: { x: 20, y: -12, zoom: 2 } })
    actor.send({ type: "SEARCH.QUERY", query: "alpha" })
    actor.send({ type: "SEARCH.RUN" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.send({ type: "MAP.SELECT_EDGE", edgeId: "edge:org-a" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.send({ type: "PAGE.OPEN", pageId: "org-a:one" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.send({ type: "EXPORT" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))

    actor.send({ type: "ORGANIZATION.CHANGE", organizationId: "org-b" })
    const switching = actor.getSnapshot()
    expect(switching.matches("configuring")).toBe(true)
    expect(switching.context).toMatchObject({
      organizationId: "org-b",
      summary: null,
      graph: null,
      searchQuery: "",
      searchResults: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      page: null,
      evidence: null,
      exported: null,
      filters: DEFAULT_MEMORY_FILTERS,
      viewport: DEFAULT_MEMORY_VIEWPORT
    })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(actor.getSnapshot().context.summary?.asOf).toContain("org-b")
  })

  it("restores map filters, viewport, and selection after opening and closing a page", async () => {
    const actor = await startReady()
    actor.send({ type: "NAVIGATE", target: { view: "map" } })
    actor.send({ type: "MAP.FILTERS", filters: { ...DEFAULT_MEMORY_FILTERS, freshness: "stale" } })
    actor.send({ type: "MAP.VIEWPORT", viewport: { x: 42, y: -8, zoom: 1.8 } })
    actor.send({ type: "MAP.SELECT_NODE", nodeId: "page:org-a:one" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.send({ type: "PAGE.OPEN", pageId: "org-a:one" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(actor.getSnapshot().context.view).toBe("wiki")
    actor.send({ type: "PAGE.BACK" })
    expect(actor.getSnapshot().context).toMatchObject({ view: "map", viewport: { x: 42, y: -8, zoom: 1.8 }, selectedNodeId: "page:org-a:one", filters: { freshness: "stale" } })
  })

  it("loads exact edge evidence and expands graph neighborhoods", async () => {
    const actor = await startReady()
    actor.send({ type: "MAP.SELECT_EDGE", edgeId: "edge:org-a" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(actor.getSnapshot().context.evidence?.evidence.raw).toBe("[[edge:org-a]]")
    actor.send({ type: "NAVIGATE", target: { view: "map" } })
    actor.send({ type: "MAP.EXPAND", nodeId: "page:org-a:two" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(api.neighborhood).toHaveBeenLastCalledWith("org-a", "page:org-a:two", 100)
  })

  it("persists an organization change made from the error state through configuring", async () => {
    let failFirstLoad = true
    const failing: MemoryApi = {
      ...api,
      dashboard: vi.fn(async (organizationId: string) => {
        if (failFirstLoad) {
          failFirstLoad = false
          throw new Error("initial load failed")
        }
        return summary(organizationId)
      }),
      configure: vi.fn(async (organizationId: string) => ({ ...access, selectedOrganizationId: organizationId }))
    }
    const actor = createActor(createMemoryMachine(failing)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    actor.send({ type: "OPEN" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))
    actor.send({ type: "ORGANIZATION.CHANGE", organizationId: "org-b" })
    // Must route through configuring (persist + refresh access), never straight to loading.
    expect(actor.getSnapshot().matches("configuring")).toBe(true)
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(failing.configure).toHaveBeenCalledWith("org-b")
    expect(actor.getSnapshot().context.organizationId).toBe("org-b")
  })

  it("keeps failed views navigable and reloads after durable capture recovery", async () => {
    let available = false
    const recoverable: MemoryApi = {
      ...api,
      dashboard: vi.fn(async (organizationId: string) => {
        if (!available) throw new Error("memory unavailable")
        return summary(organizationId)
      }),
      recover: vi.fn(async () => {
        available = true
        return {
          queuedBefore: 2,
          delivered: 2,
          retained: 0,
          discarded: 0,
          lastFailureStatus: null
        }
      })
    }
    const actor = createActor(createMemoryMachine(recoverable)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("closed"))
    actor.send({ type: "OPEN" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))

    actor.send({ type: "NAVIGATE", target: { view: "map" } })
    expect(actor.getSnapshot()).toMatchObject({
      value: "failed",
      context: { view: "map", error: "memory unavailable" }
    })

    actor.send({ type: "RECOVER" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(recoverable.recover).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.recovery).toMatchObject({
      queuedBefore: 2,
      delivered: 2,
      retained: 0
    })
  })

  it("runs a search queued while a page is still loading", async () => {
    const actor = await startReady()
    ;(api.search as ReturnType<typeof vi.fn>).mockClear()
    actor.send({ type: "SEARCH.QUERY", query: "deferred" })
    actor.send({ type: "PAGE.OPEN", pageId: "org-a:one" })
    // The debounced SEARCH.RUN lands mid-load; it must not be dropped.
    expect(actor.getSnapshot().matches("pageLoading")).toBe(true)
    actor.send({ type: "SEARCH.RUN" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready") && snapshot.context.searchResults.length > 0)
    expect(api.search).toHaveBeenCalledWith("org-a", "deferred", 50)
  })

  it("keeps query edits made while a page is loading", async () => {
    const actor = await startReady()
    ;(api.search as ReturnType<typeof vi.fn>).mockClear()
    actor.send({ type: "PAGE.OPEN", pageId: "org-a:one" })
    expect(actor.getSnapshot().matches("pageLoading")).toBe(true)
    actor.send({ type: "SEARCH.QUERY", query: "typed during load" })
    actor.send({ type: "SEARCH.RUN" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready") && snapshot.context.searchResults.length > 0)
    expect(api.search).toHaveBeenCalledWith("org-a", "typed during load", 50)
  })

  it("clears the export result once EXPORT.CLEAR fires", async () => {
    const actor = await startReady()
    actor.send({ type: "EXPORT" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready") && snapshot.context.exported !== null)
    expect(actor.getSnapshot().context.exported?.saved).toBe(true)
    actor.send({ type: "EXPORT.CLEAR" })
    expect(actor.getSnapshot().context.exported).toBeNull()
  })

  it("lays out a 10,000-node fixture deterministically without page bodies", () => {
    const nodes: ReadonlyArray<MemoryGraphNode> = Array.from({ length: 10_000 }, (_, index) => ({
      id: `page:${index}`,
      kind: "page",
      title: `Page ${index}`,
      pageId: `page-${index}`,
      topicId: `topic:${index % 40}`,
      degree: { incoming: index % 5, outgoing: index % 7 },
      freshness: "fresh",
      health: { brokenLinks: 0, contradictions: 0, orphan: false }
    }))
    const first = computeMemoryLayout(nodes, [])
    const second = computeMemoryLayout(nodes, [])
    expect(first).toHaveLength(10_000)
    expect(second).toEqual(first)
    expect(Object.keys(first[0] ?? {})).toEqual(["id", "x", "y"])
  })
})
