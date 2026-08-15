import type {
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import {
  reduceSubagentFleetEvent,
  type SubagentRunTreeContext
} from "@jingler/cli-adapters/runtime/subagents/subagent-run-tree-machine"
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

const emptyTree = (parentPiSessionId: string): SubagentRunTreeContext => ({
  parentPiSessionId,
  nodes: [],
  seenEventIds: [],
  generatedAt: 0,
  totalActive: 0,
  omitted: 0,
  activeCapacity: { used: 0, limit: 0 }
})

export const parentPiSessionIdFromFleetEvents = (
  events: ReadonlyArray<SubagentFleetEvent>,
  fallback: string
): string => {
  for (const event of events) {
    if (event._tag === "Snapshot") return event.snapshot.parentPiSessionId
    if (event._tag === "Upsert") return event.node.parentPiSessionId
  }
  return fallback
}

const projectEvents = (
  parentPiSessionId: string,
  events: ReadonlyArray<SubagentFleetEvent>
): SubagentRunTreeContext =>
  events.reduce(reduceSubagentFleetEvent, emptyTree(parentPiSessionId))

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
    tree: emptyTree(input.parentPiSessionId),
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
            return {
              tree,
              selectedId:
                context.selectedId === MAIN_FLEET_AGENT || hasNode(tree.nodes, context.selectedId)
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
