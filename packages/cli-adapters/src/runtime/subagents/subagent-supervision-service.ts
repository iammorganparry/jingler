import {
  subagentFleetNodeId,
  type SubagentFleetEvent,
  type SubagentFleetNode
} from "@jingler/core"
import { Context, Effect, Layer, Ref, SynchronizedRef } from "effect"
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

interface SupervisionState {
  readonly tree: SubagentRunTreeContext
  readonly eventLog: ReadonlyArray<SubagentFleetEvent>
  readonly registryRevision: number
  readonly childSequences: ReadonlyMap<string, number>
  readonly asyncStarts: ReadonlyMap<string, SubagentStartRecord>
  readonly durableNodeIds: ReadonlySet<string>
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
  parentPiSessionId: string
): Effect.Effect<SubagentSupervisionServiceShape> => Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<SupervisionState>({
    tree: emptySubagentRunTree(parentPiSessionId),
    eventLog: [],
    registryRevision: 0,
    childSequences: new Map(),
    asyncStarts: new Map(),
    durableNodeIds: new Set(),
    started: false,
    unsubscribes: []
  })

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

export const SubagentSupervisionServiceLive = (parentPiSessionId: string) =>
  Layer.scoped(
    SubagentSupervisionService,
    Effect.acquireRelease(
      makeSubagentSupervisionService(parentPiSessionId),
      (service) => service.stop
    )
  )
