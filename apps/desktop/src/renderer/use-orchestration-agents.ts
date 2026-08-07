import type { PlanDocument, PlanParticipant, WorkerActivity } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useEffect, useMemo } from "react"
import {
  orchestrationAgentsMachine,
  type OrchestrationAgent,
  type OrchestrationAgentsScope
} from "./orchestration-agents-machine.js"
import { rpc } from "./rpc-client.js"

const subscribe = (
  scope: OrchestrationAgentsScope,
  listener: (activity: WorkerActivity) => void,
  onFailure: (error: unknown) => void
): (() => void) =>
  rpc.agentWatchWorkers(
    scope.sessionId,
    scope.planId,
    scope.chatId,
    listener,
    onFailure
  )

const loadParticipants = (scope: OrchestrationAgentsScope) =>
  rpc.planParticipants(scope.sessionId, scope.planId)

export interface OrchestrationAgentsState {
  readonly planId: string | null
  readonly agents: ReadonlyArray<OrchestrationAgent>
  readonly participants: ReadonlyArray<PlanParticipant>
}

/** Sidebar rollup for workers that outlive the orchestrator's own turn. */
/**
 * Project a canonical plan's worker feed for the chat that produced it.
 *
 * A session's plan is shared across chats, but its live execution tabs are not:
 * another chat receives no subscription and an active subscription is torn
 * down as soon as either the plan or chat changes.
 */
export function useOrchestrationAgents(
  sessionId: string,
  chatId: string,
  plan: PlanDocument | null
): OrchestrationAgentsState {
  const planId = plan?.id ?? null
  const producingChatId = plan?.producingChatId ?? null
  const scope = useMemo<OrchestrationAgentsScope | null>(
    () =>
      planId !== null && producingChatId === chatId
        ? { sessionId, planId, chatId }
        : null,
    [sessionId, chatId, planId, producingChatId]
  )
  const [snapshot, send] = useMachine(orchestrationAgentsMachine, {
    input: { scope, subscribe, loadParticipants }
  })

  useEffect(() => {
    send({ type: "SCOPE_CHANGED", scope })
  }, [send, scope])

  const owned = snapshot.context.scope
  const current =
    scope !== null &&
    owned?.sessionId === scope.sessionId &&
    owned.planId === scope.planId &&
    owned.chatId === scope.chatId

  const agents = current ? snapshot.context.agents : []
  return {
    planId: scope?.planId ?? null,
    agents,
    participants: current ? snapshot.context.participants : []
  }
}
