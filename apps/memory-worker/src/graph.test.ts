import type { MemoryPage } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import {
  MAX_TOPIC_CLUSTERS,
  buildBoundedGraphView,
  buildGraphNeighborhood,
  findGraphEdgeEvidence
} from "./graph.js"

const fixturePage = (index: number): MemoryPage => ({
  id: `page-${index}`,
  path: `pages/page-${index}.md`,
  title: `Page ${index}`,
  revision: 1,
  aliases: [],
  tags: [`topic-${index % 100}`],
  sources: [],
  citations: [],
  relationships: [],
  body: `# Page ${index}\n\nBODY_SENTINEL_${index}\n`,
  metadata: { citationPolicy: "none" }
})

describe("bounded vault graph", () => {
  it("bounds a 10,000-page manifest and one-hop expansion without page bodies", () => {
    const pages = Array.from({ length: 10_000 }, (_, index) => fixturePage(index))
    const manifest = buildBoundedGraphView(pages, [], { limit: 75 })
    expect(manifest.totalNodes).toBe(10_000)
    expect(manifest.nodes).toHaveLength(75)
    expect(manifest.clusters.length).toBeLessThanOrEqual(MAX_TOPIC_CLUSTERS)
    expect(manifest.clusters.every((cluster) => cluster.sampleNodeIds.length <= 10)).toBe(true)
    expect(manifest.truncated).toBe(true)
    expect(JSON.stringify(manifest)).not.toContain("BODY_SENTINEL")

    const neighborhood = buildGraphNeighborhood(pages, [], "page:page-9999", 25)
    expect(neighborhood.nodes).toHaveLength(1)
    expect(neighborhood.nodes[0]?.id).toBe("page:page-9999")
    expect(JSON.stringify(neighborhood)).not.toContain("BODY_SENTINEL")
  })

  it("returns typed edge evidence separately by stable edge id", () => {
    const target = fixturePage(1)
    const source = { ...fixturePage(2), body: "# Page 2\n\nSee [[pages/page-1]].\n" }
    const view = buildBoundedGraphView([source, target], [], { limit: 10 })
    const edge = view.edges.find((candidate) => candidate.kind === "wikilink")
    expect(edge).toBeDefined()
    const evidence = findGraphEdgeEvidence([source, target], [], edge?.id ?? "")
    expect(evidence).toMatchObject({
      edge: { sourceId: "page:page-2", targetId: "page:page-1", kind: "wikilink" },
      evidence: { kind: "wikilink", pageId: "page-2", raw: "[[pages/page-1]]" }
    })
  })

  it("marks a page linked only via a dependency as non-orphan on both endpoints", () => {
    const dependant: MemoryPage = {
      ...fixturePage(1),
      relationships: [{ kind: "dependency", target: "pages/page-2" }]
    }
    const target = fixturePage(2)
    const view = buildBoundedGraphView([dependant, target], [], { limit: 10 })
    const dependantNode = view.nodes.find((node) => node.pageId === "page-1")
    const targetNode = view.nodes.find((node) => node.pageId === "page-2")
    // Dependency edge connects both — the same definition the dashboard now uses.
    expect(dependantNode?.health.orphan).toBe(false)
    expect(targetNode?.health.orphan).toBe(false)
  })

  it("reports real per-page broken wikilink counts, not a hard-coded 0", () => {
    const broken: MemoryPage = {
      ...fixturePage(1),
      body: "# Page 1\n\nA reference to [[does-not-exist]] that resolves to nothing.\n"
    }
    const view = buildBoundedGraphView([broken], [], { limit: 10 })
    const node = view.nodes.find((candidate) => candidate.pageId === "page-1")
    expect(node?.health.brokenLinks).toBeGreaterThanOrEqual(1)
  })
})
