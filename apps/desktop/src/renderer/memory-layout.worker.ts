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

const stableHash = (value: string): number => {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/** Deterministic, bounded radial layout. It never receives page bodies. */
export const computeMemoryLayout = (
  nodes: ReadonlyArray<MemoryGraphNode>,
  _edges: ReadonlyArray<MemoryGraphEdge>
): ReadonlyArray<MemoryNodePosition> => {
  const topics = new Map<string, Array<MemoryGraphNode>>()
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const topic = node.topicId ?? `kind:${node.kind}`
    const entries = topics.get(topic) ?? []
    entries.push(node)
    topics.set(topic, entries)
  }
  const groups = [...topics.entries()].sort(([left], [right]) => left.localeCompare(right))
  const result: Array<MemoryNodePosition> = []
  groups.forEach(([topic, entries], groupIndex) => {
    const groupAngle = (groupIndex / Math.max(1, groups.length)) * Math.PI * 2
    const groupRadius = groups.length <= 1 ? 0 : 190 + groups.length * 5
    const centerX = Math.cos(groupAngle) * groupRadius
    const centerY = Math.sin(groupAngle) * groupRadius
    entries.forEach((node, nodeIndex) => {
      const jitter = (stableHash(`${topic}:${node.id}`) % 10_000) / 10_000
      const angle = (nodeIndex / Math.max(1, entries.length)) * Math.PI * 2 + jitter * 0.35
      const ring = 38 + Math.floor(nodeIndex / 12) * 32
      result.push({
        id: node.id,
        x: Math.round((centerX + Math.cos(angle) * ring) * 100) / 100,
        y: Math.round((centerY + Math.sin(angle) * ring) * 100) / 100
      })
    })
  })
  return result.sort((left, right) => left.id.localeCompare(right.id))
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
