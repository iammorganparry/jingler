import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { MemoryInspector } from "./memory-inspector.js"
import { MemoryMap } from "./memory-map.js"
import type { MemoryGraphView } from "@jingler/contracts"

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class { observe() {} disconnect() {} }
  })
})
afterEach(cleanup)

const BOUNDED_NODE_COUNT = /2\/10000 nodes/
const NO_INFERRED_EDGES = /Inferred and embedding-derived relationships are not displayed/

const graph: MemoryGraphView = {
  version: 1,
  totalNodes: 10_000,
  totalEdges: 25_000,
  nodes: [
    { id: "page:a", kind: "page", title: "Alpha", pageId: "a", degree: { incoming: 0, outgoing: 1 }, freshness: "fresh", health: { brokenLinks: 0, contradictions: 0, orphan: false } },
    { id: "page:b", kind: "page", title: "Beta", pageId: "b", degree: { incoming: 1, outgoing: 0 }, freshness: "stale", health: { brokenLinks: 0, contradictions: 0, orphan: false } }
  ],
  edges: [{ id: "edge:1", sourceId: "page:a", targetId: "page:b", kind: "wikilink" }],
  clusters: [{ id: "topic:alpha", label: "Alpha topic", nodeCount: 10_000, sampleNodeIds: ["page:a"] }],
  truncated: true,
  nextCursor: "2"
}

describe("MemoryMap", () => {
  it("keeps the large vault bounded and exposes synchronized keyboard controls", () => {
    const selectNode = vi.fn()
    const selectEdge = vi.fn()
    const changeViewport = vi.fn()
    const changeFilters = vi.fn()
    render(<MemoryMap graph={graph} positions={[{ id: "page:a", x: 10, y: 20 }, { id: "page:b", x: 50, y: 50 }]} filters={{ query: "", topic: null, relationship: null, freshness: null, healthOnly: false, showIsolated: true }} viewport={{ x: 0, y: 0, zoom: 1 }} selectedNodeId={null} selectedEdgeId={null} onSelectNode={selectNode} onSelectEdge={selectEdge} onExpandNode={() => {}} onViewportChange={changeViewport} onFiltersChange={changeFilters} />)
    expect(screen.getByText(BOUNDED_NODE_COUNT)).toBeDefined()
    fireEvent.click(screen.getByTestId("memory-node-page:a"))
    expect(selectNode).toHaveBeenCalledWith("page:a")
    expect(changeViewport).toHaveBeenCalledWith({ x: -10, y: -20, zoom: 1 })
    fireEvent.click(screen.getByTestId("memory-edge-edge:1"))
    expect(selectEdge).toHaveBeenCalledWith("edge:1")
    fireEvent.click(screen.getByRole("button", { name: "Pan right" }))
    expect(changeViewport).toHaveBeenCalledWith({ x: -50, y: 0, zoom: 1 })
    fireEvent.change(screen.getByRole("combobox", { name: "Freshness filter" }), { target: { value: "stale" } })
    expect(changeFilters).toHaveBeenCalledWith(expect.objectContaining({ freshness: "stale" }))
  })

  it("shows the relationship type and exact accepted evidence without inferred edges", () => {
    const edge = graph.edges[0]
    expect(edge).toBeDefined()
    if (edge === undefined) return
    render(
      <MemoryInspector
        node={null}
        evidence={{
          edge,
          evidence: {
            kind: "wikilink",
            pageId: "a",
            path: "a.md",
            line: 7,
            raw: "[[b|Beta]]"
          }
        }}
        page={null}
        onBack={() => {}}
        onOpenPage={() => {}}
        onExpandNeighborhood={() => {}}
      />
    )
    expect(screen.getByRole("heading", { name: "wikilink" })).toBeDefined()
    expect(screen.getByText("[[b|Beta]]")).toBeDefined()
    expect(screen.getByText(NO_INFERRED_EDGES)).toBeDefined()
  })
})
