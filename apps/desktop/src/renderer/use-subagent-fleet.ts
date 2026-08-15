import { useEffect, useMemo } from "react"
import { useActorRef, useSelector } from "@xstate/react"
import type {
  SubagentFleetControlAction,
  SubagentFleetControlOutcome,
  SubagentFleetEvent,
  SubagentFleetNode
} from "@jingler/core"
import { SUBAGENT_FLEET_PROTOCOL_VERSION } from "@jingler/core"
import { rpc } from "./rpc-client.js"
import {
  MAIN_FLEET_AGENT,
  parentPiSessionIdFromFleetEvents,
  subagentFleetMachine
} from "./subagent-fleet-machine.js"

export interface SubagentFleetController {
  readonly nodes: ReadonlyArray<SubagentFleetNode>
  readonly selectedId: string
  readonly selectedNode: SubagentFleetNode | null
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
}): SubagentFleetController {
  const parentPiSessionId = parentPiSessionIdFromFleetEvents(
    input.events,
    input.piSessionId ?? `${input.sessionId}:${input.chatId}`
  )
  const actor = useActorRef(subagentFleetMachine, {
    input: { parentPiSessionId }
  })
  useEffect(() => {
    actor.send({ type: "SYNC", events: input.events })
  }, [actor, input.events])
  useEffect(() => {
    if (input.piSessionId === null && input.events.length === 0) return
    let active = true
    const refresh = async () => {
      try {
        const snapshot = await rpc.agentSubagentFleetSnapshot(
          input.sessionId,
          input.chatId,
          parentPiSessionId
        )
        if (!active) return
        actor.send({
          type: "SYNC",
          events: [
            ...input.events,
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
      }
    }
    refresh()
    const timer = window.setInterval(refresh, 1_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [
    actor,
    input.chatId,
    input.events,
    input.piSessionId,
    input.sessionId,
    parentPiSessionId
  ])
  const context = useSelector(actor, (snapshot) => snapshot.context)
  const selectedNode = useMemo(
    () => context.tree.nodes.find((node) => node.id === context.selectedId) ?? null,
    [context.tree.nodes, context.selectedId]
  )

  return {
    nodes: context.tree.nodes,
    selectedId: context.selectedId,
    selectedNode,
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
