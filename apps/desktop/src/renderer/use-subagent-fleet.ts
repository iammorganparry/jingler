import { useEffect, useMemo, useRef, useState } from "react"
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
import { completedSubagentNodes } from "./subagent-tab-store.js"
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
  readonly completedNodes: ReadonlyArray<SubagentFleetNode>
  readonly selectedLegacyAgent: Subagent | null
  readonly legacyAgentFor: (node: SubagentFleetNode) => Subagent | null
  readonly select: (id: string) => void
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
    let retryAttempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
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
            eventId: `renderer-recovery:remove:${snapshot.generatedAt}:${node.id}`,
            occurredAt: snapshot.generatedAt,
            registryRevision: snapshot.registryRevision,
            id: node.id
          }))
        retryAttempt = 0
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        actor.send({
          type: "SYNC",
          events: [
            ...eventsRef.current,
            ...completedDurable,
            {
              _tag: "Snapshot",
              version: SUBAGENT_FLEET_PROTOCOL_VERSION,
              eventId: `renderer-recovery:${snapshot.generatedAt}`,
              occurredAt: snapshot.generatedAt,
              snapshot
            }
          ]
        })
      } catch {
        // Session startup and reconnect can race the first recovery read. Retry
        // transiently without restoring steady-state polling.
        if (active && retryAttempt < 3 && retryTimer === null) {
          const delay = 250 * (4 ** retryAttempt)
          retryAttempt += 1
          retryTimer = setTimeout(() => {
            retryTimer = null
            void refresh()
          }, delay)
        }
      } finally {
        refreshInFlightRef.current = false
      }
    }
    const refreshOnFocus = () => void refresh()
    void refresh()
    window.addEventListener("focus", refreshOnFocus)
    document.addEventListener("visibilitychange", refreshOnFocus)
    // Mount/focus alone is not enough: a subagent spawned MID-TURN while the
    // window stays focused never re-triggers recovery, so a missed live fleet
    // event left the drawer empty for the whole run. The durable-status read
    // behind this RPC is a cheap local directory scan; a slow steady poll
    // reconciles both missed starts and missed completions.
    const steady = setInterval(() => void refresh(), 15_000)
    return () => {
      active = false
      clearInterval(steady)
      if (retryTimer !== null) clearTimeout(retryTimer)
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", refreshOnFocus)
    }
  }, [actor, hasFleetSession, input.chatId, input.sessionId, parentPiSessionId])
  const context = useSelector(actor, (snapshot) => snapshot.context)
  const completedNodes = useMemo(
    () => completedSubagentNodes(events),
    [events]
  )
  const [completedSelection, setCompletedSelection] = useState<string | null>(null)
  useEffect(() => {
    const selected = context.tree.nodes.find((node) => node.id === context.selectedId)
    if (
      completedSelection === null &&
      selected !== undefined &&
      ["completed", "failed", "stopped", "unknown"].includes(selected.status)
    ) actor.send({ type: "SELECT", id: MAIN_FLEET_AGENT })
  }, [actor, completedSelection, context.selectedId, context.tree.nodes])
  const completedById = useMemo(
    () => new Map(completedNodes.map((node) => [node.id, node])),
    [completedNodes]
  )
  const selectedId = completedSelection ?? context.selectedId
  const selectedNode = useMemo(() => {
    const resolved = context.tree.nodes.find((node) => node.id === selectedId) ??
      completedById.get(selectedId) ?? null
    // A workflow node is a container (its output lives in the agents it
    // controls), so a selection landing on one resolves to its first child.
    // With NO child in the tree (detached async run, journal debris, children
    // settled away), fall back to the workflow node itself — resolving to null
    // silently rendered the MAIN conversation, a dead end with no explanation.
    if (resolved?.nodeKind === "workflow") {
      return context.tree.nodes.find((node) => node.parentId === resolved.id) ?? resolved
    }
    return resolved
  }, [completedById, context.tree.nodes, selectedId])
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
    selectedId,
    selectedNode,
    completedNodes,
    selectedLegacyAgent:
      selectedNode === null ? null : legacyAgentFor(selectedNode),
    legacyAgentFor,
    select: (id) => {
      if (completedById.has(id)) {
        setCompletedSelection(id)
        return
      }
      setCompletedSelection(null)
      actor.send({ type: "SELECT", id })
    },
    control: async (node, action, message, replyTo) => {
      const requestId = crypto.randomUUID()
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
        return outcome
      } catch (cause) {
        const outcome: SubagentFleetControlOutcome = {
          version: SUBAGENT_FLEET_PROTOCOL_VERSION,
          requestId,
          runId: node.runId,
          action,
          acknowledged: false,
          status: "rejected",
          deliveryStatus: "rejected",
          sequence: 0,
          nativeRequestId: null,
          message: cause instanceof Error ? cause.message : "Subagent control failed",
          acknowledgedAt: Date.now()
        }
        return outcome
      }
    }
  }
}

export { MAIN_FLEET_AGENT }
