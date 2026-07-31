import {
  activePlanParticipants,
  applyStreamEvent,
  assistantMessage,
  settleStreaming,
  type Message,
  type PlanParticipant,
  type WorkerActivity,
  type WorkerIdentity,
  type WorkerLifecycleStatus,
  type WorkerState,
  subagentParticipantRoutingId,
  workerParticipantRoutingId
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
    listener: (activity: WorkerActivity) => void,
    onFailure: (error: unknown) => void
  ) => () => void
  readonly loadParticipants?: (
    scope: OrchestrationAgentsScope
  ) => Promise<ReadonlyArray<PlanParticipant>>
}

export interface OrchestrationAgentsContext extends OrchestrationAgentsInput {
  readonly agents: ReadonlyArray<OrchestrationAgent>
  readonly participants: ReadonlyArray<PlanParticipant>
  readonly reconnectAttempt: number
}

export type OrchestrationAgentsEvent =
  | {
      readonly type: "SCOPE_CHANGED"
      readonly scope: OrchestrationAgentsScope | null
    }
  | { readonly type: "ACTIVITY"; readonly activity: WorkerActivity }
  | {
      readonly type: "PARTICIPANTS_REFRESHED"
      readonly participants: ReadonlyArray<PlanParticipant>
    }
  | { readonly type: "PARTICIPANTS_REFRESH_FAILED"; readonly error: unknown }
  | { readonly type: "STREAM_FAILED"; readonly error: unknown }

export const MAX_WORKER_STREAM_RECONNECTS = 5
export const WORKER_STREAM_RECONNECT_BASE_MS = 250
export const WORKER_STREAM_RECONNECT_MAX_MS = 4000
export const PLAN_PARTICIPANT_REFRESH_MS = 1000

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

const settleDisconnectedAgent = (
  agent: OrchestrationAgent
): OrchestrationAgent =>
  agent.status === "queued" || agent.status === "running"
    ? {
        ...agent,
        status: "interrupted",
        statusMessage: "Worker activity stream disconnected.",
        message: settleStreaming(agent.message)
      }
    : agent

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
  scope: OrchestrationAgentsScope,
  mode: "replace" | "patch"
): ReadonlyArray<OrchestrationAgent> =>
  workers.reduce(
    (next, worker) => {
      if (!identityInScope(worker.worker, scope)) return next
      const current = next.find((agent) => agent.id === worker.worker.agentId)
      return current !== undefined && current.attempt > worker.worker.attempt
        ? next
        : replaceAgent(next, freshAgent(worker))
    },
    mode === "replace" ? [] : agents
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
    return applyReset(context.agents, activity.workers, scope, activity.mode)
  }
  if (activity._tag === "State") {
    return applyState(context.agents, activity)
  }
  return applyHarnessEvent(context.agents, activity)
}

const workerRouteFor = (worker: WorkerIdentity): string =>
  workerParticipantRoutingId(
    worker.planId,
    worker.agentId,
    worker.attempt
  )

const withoutWorkerTree = (
  participants: ReadonlyArray<PlanParticipant>,
  workerRoutingId: string
): ReadonlyArray<PlanParticipant> =>
  participants.filter(
    (participant) =>
      participant.routingId !== workerRoutingId &&
      participant.ownerRoutingId !== workerRoutingId
  )

const workerParticipant = (worker: WorkerIdentity): PlanParticipant => ({
  routingId: workerRouteFor(worker),
  displayName: worker.agentId,
  role: "worker",
  lifecycle: "running",
  ownerRoutingId: null
})

const foldParticipants = (
  participants: ReadonlyArray<PlanParticipant>,
  activity: WorkerActivity
): ReadonlyArray<PlanParticipant> => {
  if (activity._tag === "Reset") {
    let next =
      activity.mode === "replace"
        ? participants.filter(
            (participant) =>
              participant.role !== "worker" &&
              participant.ownerRoutingId?.startsWith("worker:") !== true
          )
        : participants
    for (const state of activity.workers) {
      const route = workerRouteFor(state.worker)
      next = withoutWorkerTree(next, route)
      if (state.status === "running") {
        next = [...next, workerParticipant(state.worker)]
      }
    }
    return activePlanParticipants([next])
  }

  const workerRoute = workerRouteFor(activity.worker)
  if (activity._tag === "State") {
    const next = withoutWorkerTree(participants, workerRoute)
    return activePlanParticipants([
      activity.status === "running"
        ? [...next, workerParticipant(activity.worker)]
        : next
    ])
  }

  if (activity.event._tag === "SubagentStarted") {
    const routingId = subagentParticipantRoutingId(
      workerRoute,
      activity.event.id
    )
    return activePlanParticipants([
      participants,
      [
        {
          routingId,
          displayName: activity.event.name,
          role: "subagent",
          lifecycle: "running",
          ownerRoutingId: workerRoute
        }
      ]
    ])
  }
  if (activity.event._tag === "SubagentEnded") {
    const routingId = subagentParticipantRoutingId(
      workerRoute,
      activity.event.id
    )
    return participants.filter(
      (participant) => participant.routingId !== routingId
    )
  }
  return participants
}

const reconcileWorkerParticipants = (
  participants: ReadonlyArray<PlanParticipant>,
  agents: ReadonlyArray<OrchestrationAgent>,
  planId: string
): ReadonlyArray<PlanParticipant> => {
  const liveWorkers = agents
    .filter((agent) => agent.status === "running")
    .map((agent) => ({
      routingId: workerParticipantRoutingId(
        planId,
        agent.id,
        agent.attempt
      ),
      displayName: agent.id,
      role: "worker",
      lifecycle: "running",
      ownerRoutingId: null
    }) satisfies PlanParticipant)
  const liveWorkerIds = new Set(
    liveWorkers.map((participant) => participant.routingId)
  )
  return activePlanParticipants([
    participants.filter(
      (participant) =>
        participant.role !== "worker" &&
        participant.ownerRoutingId?.startsWith("worker:") !== true
    ),
    liveWorkers,
    participants.filter(
      (participant) =>
        participant.ownerRoutingId?.startsWith("worker:") === true &&
        liveWorkerIds.has(participant.ownerRoutingId)
    )
  ])
}

const sameParticipants = (
  left: ReadonlyArray<PlanParticipant>,
  right: ReadonlyArray<PlanParticipant>
): boolean =>
  left.length === right.length &&
  left.every((participant, index) => {
    const other = right[index]
    return other !== undefined &&
      participant.routingId === other.routingId &&
      participant.displayName === other.displayName &&
      participant.role === other.role &&
      participant.lifecycle === other.lifecycle &&
      participant.ownerRoutingId === other.ownerRoutingId
  })

const mergeMainParticipants = (
  current: ReadonlyArray<PlanParticipant>,
  refreshed: ReadonlyArray<PlanParticipant>
): ReadonlyArray<PlanParticipant> =>
  activePlanParticipants([
    current.filter(
      (participant) =>
        participant.role === "worker" ||
        participant.ownerRoutingId?.startsWith("worker:") === true
    ),
    refreshed.filter(
      (participant) =>
        participant.role !== "worker" &&
        participant.ownerRoutingId?.startsWith("worker:") !== true
    )
  ])

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
      input.subscribe(
        input.scope,
        (activity) => sendBack({ type: "ACTIVITY", activity }),
        (error) => sendBack({ type: "STREAM_FAILED", error })
      )
    ),
    watchParticipants: fromCallback<
      OrchestrationAgentsEvent,
      {
        readonly scope: OrchestrationAgentsScope
        readonly load: OrchestrationAgentsInput["loadParticipants"]
      }
    >(({ sendBack, input }) => {
      const load = input.load
      if (load === undefined) return () => undefined
      let cancelled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const refresh = () => {
        load(input.scope).then(
          (participants) => {
            if (cancelled) return
            sendBack({ type: "PARTICIPANTS_REFRESHED", participants })
          },
          (error) => {
            if (cancelled) return
            sendBack({ type: "PARTICIPANTS_REFRESH_FAILED", error })
          }
        ).finally(() => {
          if (!cancelled) timer = setTimeout(refresh, PLAN_PARTICIPANT_REFRESH_MS)
        })
      }
      refresh()
      return () => {
        cancelled = true
        if (timer !== null) clearTimeout(timer)
      }
    })
  },
  guards: {
    hasScope: ({ context }) => context.scope !== null,
    sameRequestedScope: ({ context, event }) =>
      event.type === "SCOPE_CHANGED" && sameScope(context.scope, event.scope),
    receivedInScope: ({ context, event }) =>
      event.type === "ACTIVITY" && activityInScope(event.activity, context.scope),
    participantsChanged: ({ context, event }) =>
      event.type === "PARTICIPANTS_REFRESHED" &&
      !sameParticipants(
        context.participants,
        mergeMainParticipants(context.participants, event.participants)
      ),
    canReconnect: ({ context }) =>
      context.reconnectAttempt < MAX_WORKER_STREAM_RECONNECTS
  },
  actions: {
    replaceScope: assign(({ event }) =>
      event.type === "SCOPE_CHANGED"
        ? {
            scope: event.scope,
            agents: [],
            participants: [],
            reconnectAttempt: 0
          }
        : {}
    ),
    foldActivity: assign(({ context, event }) => {
      if (event.type !== "ACTIVITY") return {}
      const agents = foldActivity(context, event.activity)
      return {
        agents,
        participants: reconcileWorkerParticipants(
          foldParticipants(context.participants, event.activity),
          agents,
          event.activity._tag === "Reset"
            ? event.activity.planId
            : event.activity.worker.planId
        ),
        reconnectAttempt: 0
      }
    }),
    noteStreamFailure: assign(({ context }) => ({
      reconnectAttempt: context.reconnectAttempt + 1
    })),
    settleDisconnected: assign(({ context }) => ({
      agents: context.agents.map(settleDisconnectedAgent),
      participants: context.participants.filter(
        (participant) =>
          participant.role !== "worker" &&
          participant.ownerRoutingId?.startsWith("worker:") !== true
      )
    })),
    replaceMainParticipants: assign(({ context, event }) => {
      if (event.type !== "PARTICIPANTS_REFRESHED") return {}
      return {
        participants: mergeMainParticipants(
          context.participants,
          event.participants
        )
      }
    })
  },
  delays: {
    reconnectDelay: ({ context }) =>
      Math.min(
        WORKER_STREAM_RECONNECT_BASE_MS *
          2 ** Math.max(0, context.reconnectAttempt - 1),
        WORKER_STREAM_RECONNECT_MAX_MS
      )
  }
}).createMachine({
  id: "orchestrationAgents",
  initial: "routing",
  context: ({ input }) => ({
    ...input,
    agents: [],
    participants: [],
    reconnectAttempt: 0
  }),
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
      invoke: [
        {
          src: "watchWorkers",
          input: ({ context }) => ({
            scope: context.scope!,
            subscribe: context.subscribe
          })
        },
        {
          src: "watchParticipants",
          input: ({ context }) => ({
            scope: context.scope!,
            load: context.loadParticipants
          })
        }
      ],
      on: {
        ACTIVITY: {
          guard: "receivedInScope",
          actions: "foldActivity"
        },
        STREAM_FAILED: {
          target: "reconnecting",
          actions: "noteStreamFailure"
        },
        PARTICIPANTS_REFRESHED: {
          guard: "participantsChanged",
          actions: "replaceMainParticipants"
        },
        PARTICIPANTS_REFRESH_FAILED: {}
      }
    },
    reconnecting: {
      after: {
        reconnectDelay: [
          { guard: "canReconnect", target: "watching" },
          { target: "disconnected", actions: "settleDisconnected" }
        ]
      }
    },
    disconnected: {}
  }
})
