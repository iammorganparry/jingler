import {
  SUBAGENT_FLEET_PROTOCOL_VERSION,
  subagentFleetNodeId,
  type Subagent,
  type SubagentFleetEvent,
  type SubagentFleetNode
} from "@jingler/core"
import {
  emptySubagentRunTree,
  reduceSubagentFleetEvent,
  type SubagentRunTreeContext
} from "@jingler/cli-adapters/runtime/subagents/subagent-run-tree-reducer"
import { assign, setup } from "xstate"

export const MAIN_FLEET_AGENT = "main"
export interface SubagentFleetContext {
  readonly tree: SubagentRunTreeContext
  readonly selectedId: string
}

type SubagentFleetUiEvent =
  | { readonly type: "SYNC"; readonly events: ReadonlyArray<SubagentFleetEvent> }
  | { readonly type: "SELECT"; readonly id: string }

const legacyStatus = (
  status: Subagent["status"]
): SubagentFleetNode["status"] => {
  switch (status) {
    case "working": return "running"
    case "done": return "completed"
    case "error": return "failed"
    case "stopped": return "stopped"
  }
}

const messageTime = (agent: Subagent): number => {
  const parsed = Date.parse(agent.message.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export const legacySubagentNodeId = (
  parentRuntimeSessionId: string,
  agentId: string
): string => subagentFleetNodeId(parentRuntimeSessionId, `legacy:${agentId}`)

export const projectLegacySubagents = (
  parentRuntimeSessionId: string,
  agents: ReadonlyArray<Subagent>
): ReadonlyArray<SubagentFleetEvent> => {
  const ids = new Set(agents.map(({ id }) => id))
  return agents.map((agent) => {
    const occurredAt = messageTime(agent)
    const status = legacyStatus(agent.status)
    const node: SubagentFleetNode = {
      id: legacySubagentNodeId(parentRuntimeSessionId, agent.id),
      subagentId: `legacy:${agent.id}`,
      orchestrationRunId: `legacy:${agent.parentId ?? agent.id}`,
      nodeKind: "agent",
      registryRevision: occurredAt,
      childSequence: 1,
      runId: `legacy:${agent.id}`,
      parentId:
        agent.parentId !== null && ids.has(agent.parentId)
          ? legacySubagentNodeId(parentRuntimeSessionId, agent.parentId)
          : null,
      parentRuntimeSessionId,
      agent: agent.name,
      task: agent.description,
      model: null,
      status,
      health: "unknown",
      phase: null,
      blocking: null,
      terminal: status === "running" ? null : {
        reason: status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed",
        summary: agent.description,
        at: occurredAt,
        retryable: false
      },
      background: false,
      sessionFile: null,
      currentTool: null,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      completedAt: status === "running" ? null : occurredAt,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        durationMs: 0,
        toolCalls: 0
      },
      artifacts: [],
      attention: null
    }
    return {
      _tag: "Upsert",
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `legacy:${agent.id}:${agent.status}:${occurredAt}`,
      occurredAt,
      node
    }
  })
}

const parentOf = (event: SubagentFleetEvent): string | null => {
  if (event._tag === "Snapshot") return event.snapshot.parentRuntimeSessionId
  if (event._tag === "Upsert") return event.node.parentRuntimeSessionId
  return null
}

export const parentRuntimeSessionIdFromFleetEvents = (
  events: ReadonlyArray<SubagentFleetEvent>,
  fallback: string
): string => {
  let latest: { readonly parentRuntimeSessionId: string; readonly occurredAt: number } | null = null
  for (const event of events) {
    const parentRuntimeSessionId = parentOf(event)
    if (
      parentRuntimeSessionId !== null &&
      (latest === null || event.occurredAt >= latest.occurredAt)
    ) {
      latest = { parentRuntimeSessionId, occurredAt: event.occurredAt }
    }
  }
  return latest?.parentRuntimeSessionId ?? fallback
}

const belongsToParent = (
  event: SubagentFleetEvent,
  parentRuntimeSessionId: string
): boolean => {
  const parent = parentOf(event)
  if (parent !== null) return parent === parentRuntimeSessionId
  return event._tag === "Remove" &&
    event.id.startsWith(`${parentRuntimeSessionId}/`)
}

export const projectSubagentFleetEvents = (
  parentRuntimeSessionId: string,
  events: ReadonlyArray<SubagentFleetEvent>
): SubagentRunTreeContext =>
  events
    .filter((event) => belongsToParent(event, parentRuntimeSessionId))
    .reduce(reduceSubagentFleetEvent, emptySubagentRunTree(parentRuntimeSessionId))

const ACTIVE_STATUSES: ReadonlySet<SubagentFleetNode["status"]> = new Set([
  "queued",
  "running",
  "paused",
  "needs-attention"
])

export const settleStoppedFleet = (
  events: ReadonlyArray<SubagentFleetEvent>,
  occurredAt: number
): ReadonlyArray<SubagentFleetEvent> => {
  const parentRuntimeSessionId = parentRuntimeSessionIdFromFleetEvents(events, "")
  if (parentRuntimeSessionId === "") return events
  const activeNodes = projectSubagentFleetEvents(parentRuntimeSessionId, events).nodes.filter((node) =>
    ACTIVE_STATUSES.has(node.status)
  )
  if (activeNodes.length === 0) return events
  return [
    ...events,
    ...activeNodes.map((node) => ({
      _tag: "Upsert" as const,
      version: SUBAGENT_FLEET_PROTOCOL_VERSION,
      eventId: `global-stop:${occurredAt}:${node.runId}`,
      occurredAt,
      node: {
        ...node,
        status: "stopped" as const,
        health: "disconnected" as const,
        registryRevision: node.registryRevision + 1,
        childSequence: node.childSequence + 1,
        terminal: { reason: "stopped" as const, summary: "Parent stopped", at: occurredAt, retryable: false },
        currentTool: null,
        updatedAt: occurredAt,
        completedAt: occurredAt,
        attention: null
      }
    }))
  ]
}

const hasNode = (nodes: ReadonlyArray<SubagentFleetNode>, id: string): boolean =>
  nodes.some((node) => node.id === id)

export const subagentFleetMachine = setup({
  types: {
    context: {} as SubagentFleetContext,
    events: {} as SubagentFleetUiEvent,
    input: {} as { readonly parentRuntimeSessionId: string }
  }
}).createMachine({
  id: "subagent-fleet",
  initial: "ready",
  context: ({ input }) => ({
    tree: emptySubagentRunTree(input.parentRuntimeSessionId),
    selectedId: MAIN_FLEET_AGENT
  }),
  states: {
    ready: {
      on: {
        SYNC: {
          actions: assign(({ context, event }) => {
            const parentRuntimeSessionId = parentRuntimeSessionIdFromFleetEvents(
              event.events,
              context.tree.parentRuntimeSessionId
            )
            const tree = projectSubagentFleetEvents(parentRuntimeSessionId, event.events)
            const parentChanged =
              parentRuntimeSessionId !== context.tree.parentRuntimeSessionId
            return {
              tree,
              selectedId:
                !parentChanged &&
                (context.selectedId === MAIN_FLEET_AGENT || hasNode(tree.nodes, context.selectedId))
                  ? context.selectedId
                  : MAIN_FLEET_AGENT
            }
          })
        },
        SELECT: {
          actions: assign(({ context, event }) => ({
            selectedId:
              event.id === MAIN_FLEET_AGENT || hasNode(context.tree.nodes, event.id)
                ? event.id
                : context.selectedId
          }))
        }
      }
    }
  }
})
