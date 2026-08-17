import {
  SUBAGENT_FLEET_PROTOCOL_VERSION,
  subagentFleetNodeId,
  type Subagent,
  type SubagentFleetControlOutcome,
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
export const DEFAULT_FLEET_HEIGHT = 184
export const MIN_FLEET_HEIGHT = 112
export const MAX_FLEET_HEIGHT = 420

export interface SubagentFleetContext {
  readonly tree: SubagentRunTreeContext
  readonly selectedId: string
  readonly expanded: boolean
  readonly height: number
  readonly pendingRequestId: string | null
  readonly lastOutcome: SubagentFleetControlOutcome | null
}

type SubagentFleetUiEvent =
  | { readonly type: "SYNC"; readonly events: ReadonlyArray<SubagentFleetEvent> }
  | { readonly type: "SELECT"; readonly id: string }
  | { readonly type: "TOGGLE" }
  | { readonly type: "RESIZE"; readonly height: number }
  | { readonly type: "CONTROL_STARTED"; readonly requestId: string }
  | { readonly type: "CONTROL_SETTLED"; readonly outcome: SubagentFleetControlOutcome }

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
  parentPiSessionId: string,
  agentId: string
): string => subagentFleetNodeId(parentPiSessionId, `legacy:${agentId}`)

export const projectLegacySubagents = (
  parentPiSessionId: string,
  agents: ReadonlyArray<Subagent>
): ReadonlyArray<SubagentFleetEvent> => {
  const ids = new Set(agents.map(({ id }) => id))
  return agents.map((agent) => {
    const occurredAt = messageTime(agent)
    const status = legacyStatus(agent.status)
    const node: SubagentFleetNode = {
      id: legacySubagentNodeId(parentPiSessionId, agent.id),
      subagentId: `legacy:${agent.id}`,
      orchestrationRunId: `legacy:${agent.parentId ?? agent.id}`,
      nodeKind: "agent",
      registryRevision: occurredAt,
      childSequence: 1,
      runId: `legacy:${agent.id}`,
      parentId:
        agent.parentId !== null && ids.has(agent.parentId)
          ? legacySubagentNodeId(parentPiSessionId, agent.parentId)
          : null,
      parentPiSessionId,
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
  if (event._tag === "Snapshot") return event.snapshot.parentPiSessionId
  if (event._tag === "Upsert") return event.node.parentPiSessionId
  return null
}

export const parentPiSessionIdFromFleetEvents = (
  events: ReadonlyArray<SubagentFleetEvent>,
  fallback: string
): string => {
  let latest: { readonly parentPiSessionId: string; readonly occurredAt: number } | null = null
  for (const event of events) {
    const parentPiSessionId = parentOf(event)
    if (
      parentPiSessionId !== null &&
      (latest === null || event.occurredAt >= latest.occurredAt)
    ) {
      latest = { parentPiSessionId, occurredAt: event.occurredAt }
    }
  }
  return latest?.parentPiSessionId ?? fallback
}

const belongsToParent = (
  event: SubagentFleetEvent,
  parentPiSessionId: string
): boolean => {
  const parent = parentOf(event)
  if (parent !== null) return parent === parentPiSessionId
  return event._tag === "Remove" &&
    event.id.startsWith(`${parentPiSessionId}/`)
}

const projectEvents = (
  parentPiSessionId: string,
  events: ReadonlyArray<SubagentFleetEvent>
): SubagentRunTreeContext =>
  events
    .filter((event) => belongsToParent(event, parentPiSessionId))
    .reduce(reduceSubagentFleetEvent, emptySubagentRunTree(parentPiSessionId))

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
  const parentPiSessionId = parentPiSessionIdFromFleetEvents(events, "")
  if (parentPiSessionId === "") return events
  const activeNodes = projectEvents(parentPiSessionId, events).nodes.filter((node) =>
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
  ].slice(-512)
}

const hasNode = (nodes: ReadonlyArray<SubagentFleetNode>, id: string): boolean =>
  nodes.some((node) => node.id === id)

export const subagentFleetMachine = setup({
  types: {
    context: {} as SubagentFleetContext,
    events: {} as SubagentFleetUiEvent,
    input: {} as { readonly parentPiSessionId: string }
  }
}).createMachine({
  id: "subagent-fleet",
  initial: "ready",
  context: ({ input }) => ({
    tree: emptySubagentRunTree(input.parentPiSessionId),
    selectedId: MAIN_FLEET_AGENT,
    expanded: true,
    height: DEFAULT_FLEET_HEIGHT,
    pendingRequestId: null,
    lastOutcome: null
  }),
  states: {
    ready: {
      on: {
        SYNC: {
          actions: assign(({ context, event }) => {
            const parentPiSessionId = parentPiSessionIdFromFleetEvents(
              event.events,
              context.tree.parentPiSessionId
            )
            const tree = projectEvents(parentPiSessionId, event.events)
            const parentChanged =
              parentPiSessionId !== context.tree.parentPiSessionId
            const nodeAdded = tree.nodes.some(
              (node) => !hasNode(context.tree.nodes, node.id)
            )
            return {
              tree,
              expanded: context.expanded || nodeAdded,
              selectedId:
                !parentChanged &&
                (context.selectedId === MAIN_FLEET_AGENT || hasNode(tree.nodes, context.selectedId))
                  ? context.selectedId
                  : MAIN_FLEET_AGENT,
              ...(parentChanged
                ? { pendingRequestId: null, lastOutcome: null }
                : {})
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
        },
        TOGGLE: {
          actions: assign(({ context }) => ({ expanded: !context.expanded }))
        },
        RESIZE: {
          actions: assign(({ event }) => ({
            height: Math.max(MIN_FLEET_HEIGHT, Math.min(MAX_FLEET_HEIGHT, event.height))
          }))
        },
        CONTROL_STARTED: {
          actions: assign(({ event }) => ({ pendingRequestId: event.requestId }))
        },
        CONTROL_SETTLED: {
          actions: assign(({ event }) => ({
            pendingRequestId: null,
            lastOutcome: event.outcome
          }))
        }
      }
    }
  }
})
