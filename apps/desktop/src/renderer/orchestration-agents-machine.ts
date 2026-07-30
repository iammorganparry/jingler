import {
  applyStreamEvent,
  assistantMessage,
  settleStreaming,
  type Message,
  type WorkerActivity,
  type WorkerIdentity,
  type WorkerLifecycleStatus,
  type WorkerState
} from "@jingler/core"
import { assign, fromCallback, setup } from "xstate"

/** The exact server-side worker feed this machine currently owns. */
export interface OrchestrationAgentsScope {
  readonly sessionId: string
  readonly planId: string
  readonly chatId: string
}

/**
 * Renderer projection for one logical plan worker.
 *
 * `id` remains stable across retries so a tab can retain its identity. The
 * attempt and message change together when that worker resets; sibling
 * projections keep both their identity and transcript.
 */
export interface OrchestrationAgent {
  readonly id: string
  readonly stageIds: ReadonlyArray<string>
  readonly harness: WorkerIdentity["harness"]
  readonly model: string
  readonly attempt: number
  readonly status: WorkerLifecycleStatus
  readonly statusMessage: string | null
  readonly message: Message
}

export interface OrchestrationAgentsInput {
  readonly scope: OrchestrationAgentsScope | null
  readonly subscribe: (
    scope: OrchestrationAgentsScope,
    listener: (activity: WorkerActivity) => void
  ) => () => void
}

export interface OrchestrationAgentsContext extends OrchestrationAgentsInput {
  readonly agents: ReadonlyArray<OrchestrationAgent>
}

export type OrchestrationAgentsEvent =
  | {
      readonly type: "SCOPE_CHANGED"
      readonly scope: OrchestrationAgentsScope | null
    }
  | { readonly type: "ACTIVITY"; readonly activity: WorkerActivity }

const sameScope = (
  left: OrchestrationAgentsScope | null,
  right: OrchestrationAgentsScope | null
): boolean =>
  left?.sessionId === right?.sessionId &&
  left?.planId === right?.planId &&
  left?.chatId === right?.chatId

const identityInScope = (
  identity: WorkerIdentity,
  scope: OrchestrationAgentsScope
): boolean =>
  identity.sessionId === scope.sessionId &&
  identity.planId === scope.planId &&
  identity.producingChatId === scope.chatId

const activityInScope = (
  activity: WorkerActivity,
  scope: OrchestrationAgentsScope | null
): boolean => {
  if (scope === null) return false
  if (activity._tag === "Reset") {
    return (
      activity.sessionId === scope.sessionId &&
      activity.planId === scope.planId &&
      activity.producingChatId === scope.chatId
    )
  }
  return identityInScope(activity.worker, scope)
}

const isTerminal = (status: WorkerLifecycleStatus): boolean =>
  status === "blocked" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "completed"

const messageId = (worker: WorkerIdentity): string =>
  `orchestration:${worker.planId}:${worker.agentId}:${worker.attempt}`

const freshAgent = (state: WorkerState): OrchestrationAgent => ({
  id: state.worker.agentId,
  stageIds: state.worker.stageIds,
  harness: state.worker.harness,
  model: state.worker.model,
  attempt: state.worker.attempt,
  status: state.status,
  statusMessage: state.message,
  message: isTerminal(state.status)
    ? settleStreaming(assistantMessage(messageId(state.worker), ""))
    : assistantMessage(messageId(state.worker), "")
})

const replaceAgent = (
  agents: ReadonlyArray<OrchestrationAgent>,
  next: OrchestrationAgent
): ReadonlyArray<OrchestrationAgent> => {
  const index = agents.findIndex((agent) => agent.id === next.id)
  if (index < 0) return [...agents, next]
  return [...agents.slice(0, index), next, ...agents.slice(index + 1)]
}

const applyState = (
  agents: ReadonlyArray<OrchestrationAgent>,
  state: WorkerState
): ReadonlyArray<OrchestrationAgent> => {
  const current = agents.find((agent) => agent.id === state.worker.agentId)
  if (current !== undefined && current.attempt > state.worker.attempt) return agents
  if (current === undefined || current.attempt < state.worker.attempt) {
    return replaceAgent(agents, freshAgent(state))
  }
  const message = isTerminal(state.status)
    ? settleStreaming(current.message)
    : current.message.streaming
      ? current.message
      : { ...current.message, streaming: true }
  return replaceAgent(agents, {
    ...current,
    stageIds: state.worker.stageIds,
    harness: state.worker.harness,
    model: state.worker.model,
    attempt: state.worker.attempt,
    status: state.status,
    statusMessage: state.message,
    message
  })
}

const applyReset = (
  agents: ReadonlyArray<OrchestrationAgent>,
  workers: ReadonlyArray<WorkerState>,
  scope: OrchestrationAgentsScope
): ReadonlyArray<OrchestrationAgent> =>
  workers.reduce(
    (next, worker) => {
      if (!identityInScope(worker.worker, scope)) return next
      const current = next.find((agent) => agent.id === worker.worker.agentId)
      return current !== undefined && current.attempt > worker.worker.attempt
        ? next
        : replaceAgent(next, freshAgent(worker))
    },
    agents
  )

const applyHarnessEvent = (
  agents: ReadonlyArray<OrchestrationAgent>,
  activity: Extract<WorkerActivity, { readonly _tag: "HarnessEvent" }>
): ReadonlyArray<OrchestrationAgent> => {
  const current = agents.find((agent) => agent.id === activity.worker.agentId)
  if (current !== undefined && current.attempt > activity.worker.attempt) return agents
  const base =
    current === undefined || current.attempt < activity.worker.attempt
      ? freshAgent({ worker: activity.worker, status: "running", message: null })
      : current
  return replaceAgent(agents, {
    ...base,
    stageIds: activity.worker.stageIds,
    harness: activity.worker.harness,
    model: activity.worker.model,
    attempt: activity.worker.attempt,
    message: applyStreamEvent(base.message, activity.event)
  })
}

const foldActivity = (
  context: OrchestrationAgentsContext,
  activity: WorkerActivity
): ReadonlyArray<OrchestrationAgent> => {
  const { scope } = context
  if (scope === null || !activityInScope(activity, scope)) return context.agents
  if (activity._tag === "Reset") {
    return applyReset(context.agents, activity.workers, scope)
  }
  if (activity._tag === "State") {
    return applyState(context.agents, activity)
  }
  return applyHarnessEvent(context.agents, activity)
}

export const orchestrationAgentsMachine = setup({
  types: {
    input: {} as OrchestrationAgentsInput,
    context: {} as OrchestrationAgentsContext,
    events: {} as OrchestrationAgentsEvent
  },
  actors: {
    watchWorkers: fromCallback<
      OrchestrationAgentsEvent,
      {
        readonly scope: OrchestrationAgentsScope
        readonly subscribe: OrchestrationAgentsInput["subscribe"]
      }
    >(({ sendBack, input }) =>
      input.subscribe(input.scope, (activity) =>
        sendBack({ type: "ACTIVITY", activity })
      )
    )
  },
  guards: {
    hasScope: ({ context }) => context.scope !== null,
    sameRequestedScope: ({ context, event }) =>
      event.type === "SCOPE_CHANGED" && sameScope(context.scope, event.scope),
    receivedInScope: ({ context, event }) =>
      event.type === "ACTIVITY" && activityInScope(event.activity, context.scope)
  },
  actions: {
    replaceScope: assign(({ event }) =>
      event.type === "SCOPE_CHANGED"
        ? { scope: event.scope, agents: [] }
        : {}
    ),
    foldActivity: assign(({ context, event }) =>
      event.type === "ACTIVITY"
        ? { agents: foldActivity(context, event.activity) }
        : {}
    )
  }
}).createMachine({
  id: "orchestrationAgents",
  initial: "routing",
  context: ({ input }) => ({ ...input, agents: [] }),
  on: {
    SCOPE_CHANGED: [
      { guard: "sameRequestedScope" },
      {
        target: ".routing",
        actions: "replaceScope"
      }
    ]
  },
  states: {
    routing: {
      always: [
        { guard: "hasScope", target: "watching" },
        { target: "idle" }
      ]
    },
    idle: {},
    watching: {
      invoke: {
        src: "watchWorkers",
        input: ({ context }) => ({
          scope: context.scope!,
          subscribe: context.subscribe
        })
      },
      on: {
        ACTIVITY: {
          guard: "receivedInScope",
          actions: "foldActivity"
        }
      }
    }
  }
})
