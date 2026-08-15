import type {
  SubagentFleetEvent,
  SubagentFleetNode,
  SubagentFleetSnapshot,
  SubagentFleetStatus
} from "@jingler/core"
import { assign, createActor, setup } from "xstate"

const MAX_SEEN_EVENTS = 512
const MAX_NODE_CLOCKS = 1_024
const ACTIVE_STATUSES: ReadonlySet<SubagentFleetStatus> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])

export interface SubagentNodeClock {
  readonly id: string
  readonly occurredAt: number
  readonly present: boolean
}

export interface SubagentRunTreeContext {
  readonly parentPiSessionId: string
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly seenEventIds: ReadonlyArray<string>
  readonly nodeClocks: ReadonlyArray<SubagentNodeClock>
  readonly generatedAt: number
  readonly totalActive: number
  readonly omitted: number
  readonly activeCapacity: { readonly used: number; readonly limit: number }
}

type RunTreeEvent = { readonly type: "INGEST"; readonly event: SubagentFleetEvent }

const belongsToParent = (parentPiSessionId: string, id: string): boolean =>
  id.startsWith(`${parentPiSessionId}/`)

const createsCycle = (
  nodes: ReadonlyArray<SubagentFleetNode>,
  candidate: SubagentFleetNode
): boolean => {
  if (candidate.parentId === candidate.id) return true
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]))
  parents.set(candidate.id, candidate.parentId)
  const seen = new Set<string>([candidate.id])
  let parent = candidate.parentId
  while (parent !== null) {
    if (seen.has(parent)) return true
    seen.add(parent)
    parent = parents.get(parent) ?? null
  }
  return false
}

const upsert = (
  nodes: ReadonlyArray<SubagentFleetNode>,
  candidate: SubagentFleetNode
): ReadonlyArray<SubagentFleetNode> => {
  if (createsCycle(nodes, candidate)) return nodes
  const existing = nodes.find((node) => node.id === candidate.id)
  if (existing && existing.updatedAt > candidate.updatedAt) return nodes
  return [
    ...nodes.filter((node) => node.id !== candidate.id),
    candidate
  ].sort((left, right) =>
    left.startedAt - right.startedAt || left.id.localeCompare(right.id)
  )
}

const clockFor = (
  clocks: ReadonlyArray<SubagentNodeClock>,
  id: string
): SubagentNodeClock | undefined => clocks.find((clock) => clock.id === id)

const setClock = (
  clocks: ReadonlyArray<SubagentNodeClock>,
  next: SubagentNodeClock
): ReadonlyArray<SubagentNodeClock> => [
  ...clocks.filter((clock) => clock.id !== next.id),
  next
].slice(-MAX_NODE_CLOCKS)

const withSeen = (
  context: SubagentRunTreeContext,
  event: SubagentFleetEvent
): SubagentRunTreeContext => ({
  ...context,
  seenEventIds: [...context.seenEventIds, event.eventId].slice(-MAX_SEEN_EVENTS)
})

const validNode = (
  parentPiSessionId: string,
  node: SubagentFleetNode
): boolean =>
  node.parentPiSessionId === parentPiSessionId &&
  belongsToParent(parentPiSessionId, node.id) &&
  (node.parentId === null || belongsToParent(parentPiSessionId, node.parentId))

const reconcileSnapshot = (
  current: SubagentRunTreeContext,
  snapshot: SubagentFleetSnapshot
): SubagentRunTreeContext => {
  if (
    snapshot.parentPiSessionId !== current.parentPiSessionId ||
    snapshot.nodes.some((node) => !validNode(current.parentPiSessionId, node))
  ) return current
  const activeIds = new Set(snapshot.nodes.map(({ id }) => id))
  let nodes = current.nodes
  let nodeClocks = current.nodeClocks
  for (const node of current.nodes) {
    const clock = clockFor(nodeClocks, node.id)
    if (
      ACTIVE_STATUSES.has(node.status) &&
      !activeIds.has(node.id) &&
      (clock?.occurredAt ?? node.updatedAt) <= snapshot.generatedAt
    ) {
      nodes = upsert(nodes, {
        ...node,
        status: "unknown",
        updatedAt: snapshot.generatedAt,
        completedAt: snapshot.generatedAt,
        currentTool: null
      })
      nodeClocks = setClock(nodeClocks, {
        id: node.id,
        occurredAt: snapshot.generatedAt,
        present: true
      })
    }
  }
  for (const node of snapshot.nodes) {
    const clock = clockFor(nodeClocks, node.id)
    if (
      clock &&
      (clock.occurredAt > snapshot.generatedAt ||
        (clock.occurredAt === snapshot.generatedAt && !clock.present))
    ) continue
    nodes = upsert(nodes, node)
    nodeClocks = setClock(nodeClocks, {
      id: node.id,
      occurredAt: snapshot.generatedAt,
      present: true
    })
  }
  return {
    ...current,
    nodes,
    nodeClocks,
    ...(snapshot.generatedAt >= current.generatedAt
      ? {
          generatedAt: snapshot.generatedAt,
          totalActive: snapshot.totalActive,
          omitted: snapshot.omitted,
          activeCapacity: snapshot.activeCapacity
        }
      : {})
  }
}

export const reduceSubagentFleetEvent = (
  context: SubagentRunTreeContext,
  event: SubagentFleetEvent
): SubagentRunTreeContext => {
  if (context.seenEventIds.includes(event.eventId)) return context
  if (event._tag === "Snapshot") {
    const reconciled = reconcileSnapshot(context, event.snapshot)
    return reconciled === context ? context : withSeen(reconciled, event)
  }
  if (event._tag === "Remove") {
    if (!belongsToParent(context.parentPiSessionId, event.id)) return context
    const clock = clockFor(context.nodeClocks, event.id)
    if (clock && clock.occurredAt > event.occurredAt) return withSeen(context, event)
    return withSeen({
      ...context,
      nodes: context.nodes.filter((node) => node.id !== event.id),
      nodeClocks: setClock(context.nodeClocks, {
        id: event.id,
        occurredAt: event.occurredAt,
        present: false
      }),
      generatedAt: Math.max(context.generatedAt, event.occurredAt)
    }, event)
  }
  if (!validNode(context.parentPiSessionId, event.node)) return context
  const clock = clockFor(context.nodeClocks, event.node.id)
  if (
    clock &&
    (clock.occurredAt > event.occurredAt ||
      (clock.occurredAt === event.occurredAt && !clock.present))
  ) return withSeen(context, event)
  return withSeen({
    ...context,
    nodes: upsert(context.nodes, event.node),
    nodeClocks: setClock(context.nodeClocks, {
      id: event.node.id,
      occurredAt: event.occurredAt,
      present: true
    }),
    generatedAt: Math.max(context.generatedAt, event.occurredAt)
  }, event)
}

export const emptySubagentRunTree = (
  parentPiSessionId: string
): SubagentRunTreeContext => ({
  parentPiSessionId,
  nodes: [],
  seenEventIds: [],
  nodeClocks: [],
  generatedAt: 0,
  totalActive: 0,
  omitted: 0,
  activeCapacity: { used: 0, limit: 0 }
})

export const subagentRunTreeMachine = setup({
  types: {
    context: {} as SubagentRunTreeContext,
    events: {} as RunTreeEvent,
    input: {} as { readonly parentPiSessionId: string }
  }
}).createMachine({
  id: "subagent-run-tree",
  initial: "active",
  context: ({ input }) => emptySubagentRunTree(input.parentPiSessionId),
  states: {
    active: {
      on: {
        INGEST: {
          actions: assign(({ context, event }) =>
            reduceSubagentFleetEvent(context, event.event)
          )
        }
      }
    }
  }
})

export const createSubagentRunTreeActor = (parentPiSessionId: string) =>
  createActor(subagentRunTreeMachine, { input: { parentPiSessionId } })
