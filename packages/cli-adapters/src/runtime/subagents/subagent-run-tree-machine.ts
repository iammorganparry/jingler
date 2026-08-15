import type {
  SubagentFleetEvent,
  SubagentFleetNode,
  SubagentFleetSnapshot,
  SubagentFleetStatus
} from "@jingler/core"
import { assign, createActor, setup } from "xstate"

const MAX_SEEN_EVENTS = 512
const ACTIVE_STATUSES: ReadonlySet<SubagentFleetStatus> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])

export interface SubagentRunTreeContext {
  readonly parentPiSessionId: string
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly seenEventIds: ReadonlyArray<string>
  readonly generatedAt: number
  readonly totalActive: number
  readonly omitted: number
  readonly activeCapacity: { readonly used: number; readonly limit: number }
}

type RunTreeEvent = { readonly type: "INGEST"; readonly event: SubagentFleetEvent }

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

const reconcileSnapshot = (
  current: SubagentRunTreeContext,
  snapshot: SubagentFleetSnapshot
): ReadonlyArray<SubagentFleetNode> => {
  if (snapshot.parentPiSessionId !== current.parentPiSessionId) return current.nodes
  const activeIds = new Set(snapshot.nodes.map(({ id }) => id))
  let nodes: ReadonlyArray<SubagentFleetNode> = current.nodes.map((node) =>
    ACTIVE_STATUSES.has(node.status) &&
      !activeIds.has(node.id) &&
      node.updatedAt <= snapshot.generatedAt
      ? {
          ...node,
          status: "unknown" as const,
          updatedAt: snapshot.generatedAt,
          completedAt: snapshot.generatedAt,
          currentTool: null
        }
      : node
  )
  for (const node of snapshot.nodes) nodes = upsert(nodes, node)
  return nodes
}

export const reduceSubagentFleetEvent = (
  context: SubagentRunTreeContext,
  event: SubagentFleetEvent
): SubagentRunTreeContext => {
  if (context.seenEventIds.includes(event.eventId)) return context
  const seenEventIds = [
    ...context.seenEventIds,
    event.eventId
  ].slice(-MAX_SEEN_EVENTS)
  if (event._tag === "Snapshot") {
    return {
      ...context,
      nodes: reconcileSnapshot(context, event.snapshot),
      seenEventIds,
      generatedAt: Math.max(context.generatedAt, event.snapshot.generatedAt),
      totalActive: event.snapshot.totalActive,
      omitted: event.snapshot.omitted,
      activeCapacity: event.snapshot.activeCapacity
    }
  }
  if (event._tag === "Remove") {
    return {
      ...context,
      nodes: context.nodes.filter((node) => node.id !== event.id),
      seenEventIds,
      generatedAt: Math.max(context.generatedAt, event.occurredAt)
    }
  }
  return {
    ...context,
    nodes: upsert(context.nodes, event.node),
    seenEventIds,
    generatedAt: Math.max(context.generatedAt, event.occurredAt)
  }
}

export const subagentRunTreeMachine = setup({
  types: {
    context: {} as SubagentRunTreeContext,
    events: {} as RunTreeEvent,
    input: {} as { readonly parentPiSessionId: string }
  }
}).createMachine({
  id: "subagent-run-tree",
  initial: "active",
  context: ({ input }) => ({
    parentPiSessionId: input.parentPiSessionId,
    nodes: [],
    seenEventIds: [],
    generatedAt: 0,
    totalActive: 0,
    omitted: 0,
    activeCapacity: { used: 0, limit: 0 }
  }),
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
