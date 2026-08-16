import { useEffect, useMemo, useRef } from "react"
import { useActorRef, useSelector } from "@xstate/react"
import type {
  Subagent,
  SubagentFleetControlAction,
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import { SUBAGENT_FLEET_PROTOCOL_VERSION } from "@jingler/core"
import { rpc } from "./rpc-client.js"
import {
  MAIN_FLEET_AGENT,
  legacySubagentNodeId,
  parentPiSessionIdFromFleetEvents,
  projectLegacySubagents,
  subagentFleetMachine
} from "./subagent-fleet-machine.js"

const EMPTY_LEGACY_AGENTS: ReadonlyArray<Subagent> = []

export interface SubagentFleetController {
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
  readonly selectedNode: SubagentFleetNode | null
  readonly selectedLegacyAgent: Subagent | null
  readonly legacyAgentFor: (node: SubagentFleetNode) => Subagent | null
  readonly expanded: boolean
  readonly height: number
  readonly pending: boolean
  readonly lastOutcome: SubagentFleetControlOutcome | null
  readonly select: (id: string) => void
  readonly toggle: () => void
  readonly resize: (height: number) => void
  readonly control: (
    node: SubagentFleetNode,
    action: SubagentFleetControlAction,
    message?: string,
    replyTo?: string
  ) => Promise<SubagentFleetControlOutcome>
}

export function useSubagentFleet(input: {
  readonly sessionId: string
  readonly chatId: string
  readonly piSessionId: string | null
  readonly events: ReadonlyArray<SubagentFleetEvent>
  readonly legacyAgents?: ReadonlyArray<Subagent>
}): SubagentFleetController {
  const parentPiSessionId = parentPiSessionIdFromFleetEvents(
    input.events,
    input.piSessionId ?? `${input.sessionId}:${input.chatId}`
  )
  const legacyAgents = input.legacyAgents ?? EMPTY_LEGACY_AGENTS
  const projectedLegacy = useMemo(
    () => projectLegacySubagents(parentPiSessionId, legacyAgents),
    [parentPiSessionId, legacyAgents]
  )
  const events = useMemo(
    () => [...input.events, ...projectedLegacy],
    [input.events, projectedLegacy]
  )
  const eventsRef = useRef(events)
  eventsRef.current = events
  const refreshInFlightRef = useRef(false)
  const actor = useActorRef(subagentFleetMachine, {
    input: { parentPiSessionId }
  })
  useEffect(() => {
    actor.send({ type: "SYNC", events })
  }, [actor, events])
  const hasFleetSession = input.piSessionId !== null || input.events.length > 0
  useEffect(() => {
    if (!hasFleetSession) return
    let active = true
    const refresh = async () => {
      if (refreshInFlightRef.current) return
      refreshInFlightRef.current = true
      try {
        const snapshot = await rpc.agentSubagentFleetSnapshot(
          input.sessionId,
          input.chatId,
          parentPiSessionId
        )
        if (!active) return
        const snapshotIds = new Set(snapshot.nodes.map((node) => node.id))
        const completedDurable = actor.getSnapshot().context.tree.nodes
          .filter((node) =>
            node.health === "unknown" && !snapshotIds.has(node.id)
          )
          .map((node): SubagentFleetEvent => ({
            _tag: "Remove",
            version: SUBAGENT_FLEET_PROTOCOL_VERSION,
            eventId: `renderer-poll:remove:${snapshot.generatedAt}:${node.id}`,
            occurredAt: snapshot.generatedAt,
            registryRevision: snapshot.registryRevision,
            id: node.id
          }))
        actor.send({
          type: "SYNC",
          events: [
            ...eventsRef.current,
            ...completedDurable,
            {
              _tag: "Snapshot",
              version: SUBAGENT_FLEET_PROTOCOL_VERSION,
              eventId: `renderer-poll:${snapshot.generatedAt}`,
              occurredAt: snapshot.generatedAt,
              snapshot
            }
          ]
        })
      } catch {
        // The Pi session can legitimately be inactive before its first turn or
        // after disposal; lifecycle events remain the last factual projection.
      } finally {
        refreshInFlightRef.current = false
      }
    }
    const refreshOnFocus = () => void refresh()
    void refresh()
    window.addEventListener("focus", refreshOnFocus)
    document.addEventListener("visibilitychange", refreshOnFocus)
    return () => {
      active = false
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", refreshOnFocus)
    }
  }, [actor, hasFleetSession, input.chatId, input.sessionId, parentPiSessionId])
  const context = useSelector(actor, (snapshot) => snapshot.context)
  const selectedNode = useMemo(
    () => context.tree.nodes.find((node) => node.id === context.selectedId) ?? null,
    [context.tree.nodes, context.selectedId]
  )
  const legacyByNodeId = useMemo(
    () => new Map(legacyAgents.map((agent) => [
      legacySubagentNodeId(parentPiSessionId, agent.id),
      agent
    ])),
    [legacyAgents, parentPiSessionId]
  )
  const legacyAgentFor = (node: SubagentFleetNode): Subagent | null =>
    legacyByNodeId.get(node.id) ?? null

  return {
    nodes: context.tree.nodes,
    selectedId: context.selectedId,
    selectedNode,
    selectedLegacyAgent:
      selectedNode === null ? null : legacyAgentFor(selectedNode),
    legacyAgentFor,
    expanded: context.expanded,
    height: context.height,
    pending: context.pendingRequestId !== null,
    lastOutcome: context.lastOutcome,
    select: (id) => actor.send({ type: "SELECT", id }),
    toggle: () => actor.send({ type: "TOGGLE" }),
    resize: (height) => actor.send({ type: "RESIZE", height }),
    control: async (node, action, message, replyTo) => {
      const requestId = crypto.randomUUID()
      actor.send({ type: "CONTROL_STARTED", requestId })
      try {
        const outcome = await rpc.agentControlSubagent(input.sessionId, input.chatId, {
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          requestId,
          parentPiSessionId: context.tree.parentPiSessionId,
          runId: node.runId,
          action,
          message: message ?? null,
          replyTo: replyTo ?? null
        })
        actor.send({ type: "CONTROL_SETTLED", outcome })
        return outcome
      } catch (cause) {
        const outcome: SubagentFleetControlOutcome = {
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          requestId,
          runId: node.runId,
          action,
          acknowledged: false,
          status: "rejected",
          message: cause instanceof Error ? cause.message : "Subagent control failed",
          acknowledgedAt: Date.now()
        }
        actor.send({ type: "CONTROL_SETTLED", outcome })
        return outcome
      }
    }
  }
}

export { MAIN_FLEET_AGENT }
