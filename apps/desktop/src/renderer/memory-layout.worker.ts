import type { MemoryGraphEdge, MemoryGraphNode } from "@jingler/contracts"
import type { MemoryNodePosition } from "@jingler/ui"

export interface MemoryLayoutRequest {
  readonly requestId: number
  readonly nodes: ReadonlyArray<MemoryGraphNode>
  readonly edges: ReadonlyArray<MemoryGraphEdge>
}

export interface MemoryLayoutResponse {
  readonly requestId: number
  readonly positions: ReadonlyArray<MemoryNodePosition>
}

const TAU = Math.PI * 2

// FNV-1a (32-bit): a stable per-node hash used only for deterministic jitter.
const FNV_OFFSET_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619

const stableHash = (value: string): number => {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

// Radial-layout geometry, all in canvas px — named so the deterministic output
// is auditable and never a bare literal.
const GROUP_RADIUS_BASE = 190
const GROUP_RADIUS_PER_GROUP = 5
const NODE_RING_BASE = 38
const NODE_RING_STEP = 32
const NODES_PER_RING = 12
const JITTER_BUCKETS = 10_000
const JITTER_STRENGTH = 0.35
const COORD_DECIMALS = 100 // round positions to 2 dp

const byId = (left: { id: string }, right: { id: string }): number => left.id.localeCompare(right.id)
const roundCoord = (value: number): number => Math.round(value * COORD_DECIMALS) / COORD_DECIMALS

/** Deterministic jitter in [0, 1) from a node's identity within its topic. */
const jitterFor = (topic: string, nodeId: string): number =>
  (stableHash(`${topic}:${nodeId}`) % JITTER_BUCKETS) / JITTER_BUCKETS

/** Group nodes by topic (falling back to kind), with stable ordering throughout. */
const groupNodesByTopic = (
  nodes: ReadonlyArray<MemoryGraphNode>
): ReadonlyArray<readonly [string, ReadonlyArray<MemoryGraphNode>]> => {
  const topics = new Map<string, Array<MemoryGraphNode>>()
  for (const node of [...nodes].sort(byId)) {
    const topic = node.topicId ?? `kind:${node.kind}`
    const entries = topics.get(topic) ?? []
    entries.push(node)
    topics.set(topic, entries)
  }
  return [...topics.entries()].sort(([left], [right]) => left.localeCompare(right))
}

/** Deterministic, bounded radial layout. It never receives page bodies. */
export const computeMemoryLayout = (
  nodes: ReadonlyArray<MemoryGraphNode>,
  _edges: ReadonlyArray<MemoryGraphEdge>
): ReadonlyArray<MemoryNodePosition> => {
  const groups = groupNodesByTopic(nodes)
  const positions: Array<MemoryNodePosition> = []
  groups.forEach(([topic, entries], groupIndex) => {
    const groupAngle = (groupIndex / Math.max(1, groups.length)) * TAU
    const groupRadius =
      groups.length <= 1 ? 0 : GROUP_RADIUS_BASE + groups.length * GROUP_RADIUS_PER_GROUP
    const centerX = Math.cos(groupAngle) * groupRadius
    const centerY = Math.sin(groupAngle) * groupRadius
    entries.forEach((node, nodeIndex) => {
      const angle =
        (nodeIndex / Math.max(1, entries.length)) * TAU + jitterFor(topic, node.id) * JITTER_STRENGTH
      const ring = NODE_RING_BASE + Math.floor(nodeIndex / NODES_PER_RING) * NODE_RING_STEP
      positions.push({
        id: node.id,
        x: roundCoord(centerX + Math.cos(angle) * ring),
        y: roundCoord(centerY + Math.sin(angle) * ring)
      })
    })
  })
  return positions.sort(byId)
}

if (typeof self !== "undefined" && "postMessage" in self) {
  self.addEventListener("message", (event: MessageEvent<MemoryLayoutRequest>) => {
    const response: MemoryLayoutResponse = {
      requestId: event.data.requestId,
      positions: computeMemoryLayout(event.data.nodes, event.data.edges)
    }
    self.postMessage(response)
  })
}
