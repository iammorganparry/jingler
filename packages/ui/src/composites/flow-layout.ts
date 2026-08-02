import Dagre from "@dagrejs/dagre"

/**
 * Shared Dagre top-down layout used by every react-flow canvas in the plan
 * surfaces (`plan-flow`, `plan-workflow`). It is deliberately graph-agnostic:
 * it takes only ids + `from`/`to` edges and a node box size, and returns the
 * top-left position of each node keyed by id. Callers keep ownership of their
 * own node/edge shapes and styling — this only does the geometry.
 */

/** Any node with a stable id — the only thing the layout needs to place it. */
export interface DagreNodeInput {
  readonly id: string
}

/** A directed edge between two node ids. */
export interface DagreEdgeInput {
  readonly from: string
  readonly to: string
}

/** Top-left corner of a laid-out node, already offset from Dagre's centre. */
export interface DagrePosition {
  readonly x: number
  readonly y: number
}

export interface DagreLayoutOptions {
  readonly nodeWidth: number
  readonly nodeHeight: number
  /** Gap between nodes in the same rank (default 48). */
  readonly nodesep?: number
  /** Gap between ranks (default 64). */
  readonly ranksep?: number
}

/**
 * Run Dagre TB over the graph and return each node's top-left position keyed by
 * id. Dagre reports node *centres*; we subtract half the box so react-flow (which
 * positions from the top-left) draws them where Dagre intended. Nodes Dagre never
 * placed fall back to the origin rather than throwing.
 */
export const layoutDagre = (
  nodes: ReadonlyArray<DagreNodeInput>,
  edges: ReadonlyArray<DagreEdgeInput>,
  options: DagreLayoutOptions
): Map<string, DagrePosition> => {
  const { nodeWidth, nodeHeight } = options
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: "TB",
    nodesep: options.nodesep ?? 48,
    ranksep: options.ranksep ?? 64,
    marginx: 16,
    marginy: 16
  })
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth, height: nodeHeight })
  for (const e of edges) g.setEdge(e.from, e.to)
  Dagre.layout(g)

  const positions = new Map<string, DagrePosition>()
  for (const n of nodes) {
    const pos = g.node(n.id)
    positions.set(n.id, {
      x: (pos?.x ?? 0) - nodeWidth / 2,
      y: (pos?.y ?? 0) - nodeHeight / 2
    })
  }
  return positions
}
