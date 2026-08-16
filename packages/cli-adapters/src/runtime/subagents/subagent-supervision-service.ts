import {
  subagentFleetNodeId,
  type SubagentControlReceipt,
  type SubagentFleetControlOutcome,
  type SubagentFleetControlRequest,
  type SubagentFleetEvent,
  type SubagentFleetNode
} from "@jingler/core"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Ref,
  SynchronizedRef
} from "effect"
import {
  emptySubagentRunTree,
  reduceSubagentFleetEvent,
  type SubagentRunTreeContext
} from "./subagent-run-tree-reducer.js"

const MAX_REPLAY_EVENTS = 256

export interface SubagentStartRecord {
  readonly mode?: string
  readonly agent?: string
  readonly goal?: string
  readonly task?: string
}

type ControlRegistration =
  | { readonly _tag: "Cached"; readonly outcome: SubagentFleetControlOutcome }
  | {
      readonly _tag: "Pending"
      readonly deferred: Deferred.Deferred<SubagentFleetControlOutcome>
    }
  | {
      readonly _tag: "Execute"
      readonly deferred: Deferred.Deferred<SubagentFleetControlOutcome>
      readonly sequence: number
    }

interface SupervisionState {
  readonly tree: SubagentRunTreeContext
  readonly eventLog: ReadonlyArray<SubagentFleetEvent>
  readonly registryRevision: number
  readonly childSequences: ReadonlyMap<string, number>
  readonly asyncStarts: ReadonlyMap<string, SubagentStartRecord>
  readonly durableNodeIds: ReadonlySet<string>
  readonly controlSequence: number
  readonly controlOutcomes: ReadonlyMap<string, SubagentFleetControlOutcome>
  readonly controlReceipts: ReadonlyArray<SubagentControlReceipt>
  readonly pendingControls: ReadonlyMap<
    string,
    Deferred.Deferred<SubagentFleetControlOutcome>
  >
  readonly started: boolean
  readonly unsubscribes: ReadonlyArray<() => void>
}

export interface SubagentSupervisionServiceShape {
  readonly state: Effect.Effect<SupervisionState>
  readonly publish: (event: SubagentFleetEvent) => Effect.Effect<void>
  readonly nextRevision: Effect.Effect<number>
  readonly identity: (
    subagentId: string,
    orchestrationRunId: string,
    nodeKind?: SubagentFleetNode["nodeKind"]
  ) => Effect.Effect<Pick<SubagentFleetNode,
    "id" | "subagentId" | "orchestrationRunId" | "nodeKind" |
    "registryRevision" | "childSequence" | "health" | "phase" |
    "blocking" | "terminal"
  >>
  readonly replay: (afterRevision?: number) => Effect.Effect<ReadonlyArray<SubagentFleetEvent>>
  readonly putStart: (runId: string, start: SubagentStartRecord) => Effect.Effect<void>
  readonly removeStart: (runId: string) => Effect.Effect<void>
  readonly setDurableNodeIds: (ids: ReadonlySet<string>) => Effect.Effect<void>
  readonly submitControl: (
    request: SubagentFleetControlRequest,
    execute: (sequence: number) => Effect.Effect<SubagentFleetControlOutcome>
  ) => Effect.Effect<SubagentFleetControlOutcome>
  readonly controlReceipts: Effect.Effect<ReadonlyArray<SubagentControlReceipt>>
  readonly start: (subscribe: () => ReadonlyArray<() => void>) => Effect.Effect<boolean>
  readonly stop: Effect.Effect<void>
}

export class SubagentSupervisionService extends Context.Tag(
  "@jingler/SubagentSupervisionService"
)<SubagentSupervisionService, SubagentSupervisionServiceShape>() {}

const eventRevision = (event: SubagentFleetEvent): number => {
  if (event._tag === "Snapshot") return event.snapshot.registryRevision
  if (event._tag === "Upsert") return event.node.registryRevision
  return event.registryRevision
}

export const makeSubagentSupervisionService = (
  parentPiSessionId: string,
  now: () => number = Date.now
): Effect.Effect<SubagentSupervisionServiceShape> => Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<SupervisionState>({
    tree: emptySubagentRunTree(parentPiSessionId),
    eventLog: [],
    registryRevision: 0,
    childSequences: new Map(),
    asyncStarts: new Map(),
    durableNodeIds: new Set(),
    controlSequence: 0,
    controlOutcomes: new Map(),
    controlReceipts: [],
    pendingControls: new Map(),
    started: false,
    unsubscribes: []
  })
  const controlGate = yield* Effect.makeSemaphore(1)

  const modify = <A>(f: (state: SupervisionState) => readonly [A, SupervisionState]) =>
    Ref.modify(ref, f)

  return {
    state: Ref.get(ref),
    publish: (event) => Ref.update(ref, (state) => ({
      ...state,
      tree: reduceSubagentFleetEvent(state.tree, event),
      eventLog: [...state.eventLog, event].slice(-MAX_REPLAY_EVENTS),
      registryRevision: Math.max(state.registryRevision, eventRevision(event))
    })),
    nextRevision: modify((state) => {
      const revision = state.registryRevision + 1
      return [revision, { ...state, registryRevision: revision }]
    }),
    identity: (subagentId, orchestrationRunId, nodeKind = "agent") =>
      modify((state) => {
        const childSequence = (state.childSequences.get(subagentId) ?? 0) + 1
        const registryRevision = state.registryRevision + 1
        const childSequences = new Map(state.childSequences)
        childSequences.set(subagentId, childSequence)
        return [{
          id: subagentFleetNodeId(parentPiSessionId, subagentId),
          subagentId,
          orchestrationRunId,
          nodeKind,
          registryRevision,
          childSequence,
          health: "connected" as const,
          phase: null,
          blocking: null,
          terminal: null
        }, { ...state, childSequences, registryRevision }]
      }),
    replay: (afterRevision = 0) => Ref.get(ref).pipe(Effect.map((state) => [
      ...new Map(
        state.eventLog
          .filter((event) => eventRevision(event) > afterRevision)
          .map((event) => [event.eventId, event] as const)
      ).values()
    ])),
    putStart: (runId, start) => Ref.update(ref, (state) => {
      const asyncStarts = new Map(state.asyncStarts)
      asyncStarts.set(runId, start)
      return { ...state, asyncStarts }
    }),
    removeStart: (runId) => Ref.update(ref, (state) => {
      const asyncStarts = new Map(state.asyncStarts)
      asyncStarts.delete(runId)
      return { ...state, asyncStarts }
    }),
    setDurableNodeIds: (durableNodeIds) => Ref.update(ref, (state) => ({
      ...state,
      durableNodeIds: new Set(durableNodeIds)
    })),
    submitControl: (request, execute) => Effect.gen(function* () {
      const candidate = yield* Deferred.make<SubagentFleetControlOutcome>()
      const registration = yield* SynchronizedRef.modifyEffect(
        ref,
        (state): Effect.Effect<readonly [ControlRegistration, SupervisionState]> => {
        const cached = state.controlOutcomes.get(request.requestId)
        if (cached) return Effect.succeed([
          { _tag: "Cached" as const, outcome: cached },
          state
        ] as const)
        const pending = state.pendingControls.get(request.requestId)
        if (pending) return Effect.succeed([
          { _tag: "Pending" as const, deferred: pending },
          state
        ] as const)
        const sequence = state.controlSequence + 1
        const pendingControls = new Map(state.pendingControls)
        pendingControls.set(request.requestId, candidate)
        const queued: SubagentControlReceipt = {
          version: 2,
          messageId: request.requestId,
          parentPiSessionId,
          subagentId: request.runId,
          sequence,
          status: "queued",
          occurredAt: now(),
          message: null
        }
        return Effect.succeed([{
          _tag: "Execute" as const,
          deferred: candidate,
          sequence
        }, {
          ...state,
          controlSequence: sequence,
          pendingControls,
          controlReceipts: [...state.controlReceipts, queued].slice(-MAX_REPLAY_EVENTS)
        }] as const)
      })
      if (registration._tag === "Cached") return registration.outcome
      if (registration._tag === "Pending") return yield* Deferred.await(registration.deferred)
      const outcome = yield* controlGate.withPermits(1)(
        execute(registration.sequence).pipe(
          Effect.catchAllCause((cause) => Effect.succeed({
            version: 2 as const,
            requestId: request.requestId,
            runId: request.runId,
            action: request.action,
            acknowledged: false,
            status: "rejected" as const,
            deliveryStatus: "rejected" as const,
            sequence: registration.sequence,
            nativeRequestId: null,
            message: Cause.pretty(cause),
            acknowledgedAt: now()
          }))
        )
      )
      yield* Ref.update(ref, (state) => {
        const pendingControls = new Map(state.pendingControls)
        pendingControls.delete(request.requestId)
        const controlOutcomes = new Map(state.controlOutcomes)
        controlOutcomes.set(request.requestId, outcome)
        const receipt: SubagentControlReceipt = {
          version: 2,
          messageId: request.requestId,
          parentPiSessionId,
          subagentId: request.runId,
          sequence: registration.sequence,
          status: outcome.deliveryStatus,
          occurredAt: outcome.acknowledgedAt,
          message: outcome.message
        }
        return {
          ...state,
          pendingControls,
          controlOutcomes,
          controlReceipts: [...state.controlReceipts, receipt].slice(-MAX_REPLAY_EVENTS)
        }
      })
      yield* Deferred.succeed(registration.deferred, outcome)
      return outcome
    }),
    controlReceipts: Ref.get(ref).pipe(Effect.map(({ controlReceipts }) => controlReceipts)),
    start: (subscribe) => SynchronizedRef.modifyEffect(ref, (state) => {
      if (state.started) return Effect.succeed([false, state] as const)
      return Effect.sync(() => [true, {
        ...state,
        started: true,
        unsubscribes: subscribe()
      }] as const)
    }),
    stop: Ref.modify(ref, (state) => [state.unsubscribes, {
      ...state,
      tree: emptySubagentRunTree(parentPiSessionId),
      eventLog: [],
      registryRevision: 0,
      childSequences: new Map<string, number>(),
      asyncStarts: new Map<string, SubagentStartRecord>(),
      durableNodeIds: new Set<string>(),
      controlSequence: 0,
      controlOutcomes: new Map<string, SubagentFleetControlOutcome>(),
      controlReceipts: [],
      pendingControls: new Map<
        string,
        Deferred.Deferred<SubagentFleetControlOutcome>
      >(),
      started: false,
      unsubscribes: []
    }] as const).pipe(
      Effect.flatMap((unsubscribes) => Effect.forEach(
        unsubscribes,
        (unsubscribe) => Effect.sync(unsubscribe),
        { discard: true }
      )),
      Effect.asVoid
    )
  }
})

export const SubagentSupervisionServiceLive = (
  parentPiSessionId: string,
  now: () => number = Date.now
) =>
  Layer.scoped(
    SubagentSupervisionService,
    Effect.acquireRelease(
      makeSubagentSupervisionService(parentPiSessionId, now),
      (service) => service.stop
    )
  )
