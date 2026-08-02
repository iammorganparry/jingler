import type {
  MemoryAccess,
  MemoryDashboardSummary,
  MemoryGraphNode,
  MemoryGraphView,
  MemoryPageDetail,
  MemoryReviewItem
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

const review: MemoryReviewItem = {
  id: "proposal:set:1",
  workflowId: "workflow:1",
  sourceId: "source:1",
  proposedBy: "agent:1",
  createdAt: "2026-08-01T00:00:00.000Z",
  status: "open",
  changeKind: "factual",
  pages: [{ proposalId: "proposal:1", pageId: "page:1", title: "One", baseRevisionId: "revision:1", summary: "Update", markdown: "# One" }]
}

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

const reviewFixture: MemoryApi["review"] = async (_organizationId, proposalId) => ({
  status: "conflict",
  proposalId,
  conflicts: [
    {
      pageId: "page:1",
      expectedBaseRevisionId: "revision:1",
      currentHeadRevisionId: "revision:2"
    }
  ]
})

const api: MemoryApi = {
  access: vi.fn(async () => access),
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
  reviews: vi.fn(async () => [review]),
  review: vi.fn(reviewFixture),
  export: vi.fn(async (organizationId: string) => ({ filename: `${organizationId}.zip`, saved: true }))
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
      reviews: [],
      searchQuery: "",
      searchResults: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      selectedReviewId: null,
      page: null,
      evidence: null,
      reviewResult: null,
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

  it("loads exact edge evidence and keeps conflicts interactive", async () => {
    const actor = await startReady()
    actor.send({ type: "MAP.SELECT_EDGE", edgeId: "edge:org-a" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(actor.getSnapshot().context.evidence?.evidence.raw).toBe("[[edge:org-a]]")
    actor.send({ type: "REVIEW.DECIDE", proposalId: review.id, action: "approve" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready") && snapshot.context.reviewResult?.status === "conflict")
    expect(actor.getSnapshot().context.reviewResult?.conflicts[0]?.currentHeadRevisionId).toBe("revision:2")
    actor.send({ type: "NAVIGATE", target: { view: "map" } })
    actor.send({ type: "MAP.EXPAND", nodeId: "page:org-a:two" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    expect(api.neighborhood).toHaveBeenLastCalledWith("org-a", "page:org-a:two", 100)
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
