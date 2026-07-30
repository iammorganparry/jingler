import type { PlanDocument, WorkerActivity } from "@jingler/core"
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

export interface OrchestrationAgentsState {
  readonly planId: string | null
  readonly agents: ReadonlyArray<OrchestrationAgent>
}

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
    input: { scope, subscribe }
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

  return {
    planId: scope?.planId ?? null,
    agents: current ? snapshot.context.agents : []
  }
}
