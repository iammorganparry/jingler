import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  SubagentControlReceipt,
  SubagentFleetControlOutcome,
  SubagentFleetControlRequest,
  subagentFleetNodeId,
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
  Schema,
  SynchronizedRef
} from "effect"
import {
  emptySubagentRunTree,
  reduceSubagentFleetEvent,
  type SubagentRunTreeContext
} from "./subagent-run-tree-reducer.js"

const MAX_REPLAY_EVENTS = 256
const ControlJournal = Schema.Struct({
  version: Schema.Literal(2),
  parentPiSessionId: Schema.String,
  sequence: Schema.Number,
  pending: Schema.Array(Schema.Struct({
    request: SubagentFleetControlRequest,
    sequence: Schema.Number
  })),
  outcomes: Schema.Array(SubagentFleetControlOutcome),
  receipts: Schema.Array(SubagentControlReceipt)
})

export interface SubagentControlJournal {
  readonly load: Effect.Effect<typeof ControlJournal.Type, Error>
  readonly save: (journal: typeof ControlJournal.Type) => Effect.Effect<void, Error>
}

export const makeSubagentControlJournal = (input: {
  readonly asyncDir: string
  readonly parentPiSessionId: string
}): SubagentControlJournal => {
  const key = createHash("sha256").update(input.parentPiSessionId).digest("hex")
  const directory = join(input.asyncDir, ".jingler-supervision")
  const path = join(directory, `${key}.json`)
  const empty = {
    version: 2 as const,
    parentPiSessionId: input.parentPiSessionId,
    sequence: 0,
    pending: [],
    outcomes: [],
    receipts: []
  }
  return {
    load: Effect.tryPromise({
      try: async () => {
        try {
          const decoded = await Schema.decodeUnknownPromise(
            Schema.parseJson(ControlJournal)
          )(await readFile(path, "utf8"), { onExcessProperty: "error" })
          if (decoded.parentPiSessionId !== input.parentPiSessionId) {
            throw new Error("Subagent control journal belongs to another parent session")
          }
          return decoded
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return empty
          throw cause
        }
      },
      catch: (cause) => cause instanceof Error
        ? cause
        : new Error("Could not read the subagent control journal")
    }),
    save: (journal) => Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 })
        await rename(temporary, path)
      },
      catch: (cause) => cause instanceof Error
        ? cause
        : new Error("Could not persist the subagent control journal")
    })
  }
}

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
  readonly controlsLoaded: boolean
  readonly controlSequence: number
  readonly controlOutcomes: ReadonlyMap<string, SubagentFleetControlOutcome>
  readonly controlReceipts: ReadonlyArray<SubagentControlReceipt>
  readonly pendingControlRequests: ReadonlyMap<string, {
    readonly request: SubagentFleetControlRequest
    readonly sequence: number
  }>
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
  now: () => number = Date.now,
  journal?: SubagentControlJournal
): Effect.Effect<SubagentSupervisionServiceShape> => Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<SupervisionState>({
    tree: emptySubagentRunTree(parentPiSessionId),
    eventLog: [],
    registryRevision: 0,
    childSequences: new Map(),
    asyncStarts: new Map(),
    durableNodeIds: new Set(),
    controlsLoaded: journal === undefined,
    controlSequence: 0,
    controlOutcomes: new Map(),
    controlReceipts: [],
    pendingControlRequests: new Map(),
    pendingControls: new Map(),
    started: false,
    unsubscribes: []
  })
  const controlGate = yield* Effect.makeSemaphore(1)
  const loadGate = yield* Effect.makeSemaphore(1)

  const modify = <A>(f: (state: SupervisionState) => readonly [A, SupervisionState]) =>
    Ref.modify(ref, f)
  const persistControls = (state: SupervisionState): Effect.Effect<void, Error> =>
    journal?.save({
      version: 2,
      parentPiSessionId,
      sequence: state.controlSequence,
      pending: [...state.pendingControlRequests.values()].slice(-MAX_REPLAY_EVENTS),
      outcomes: [...state.controlOutcomes.values()].slice(-MAX_REPLAY_EVENTS),
      receipts: state.controlReceipts.slice(-MAX_REPLAY_EVENTS)
    }) ?? Effect.void
  const ensureControlsLoaded: Effect.Effect<void, Error> = journal
    ? loadGate.withPermits(1)(Effect.gen(function* () {
        if ((yield* Ref.get(ref)).controlsLoaded) return
        const restored = yield* journal.load
        const recoveredPending = restored.pending.map(({ request, sequence }) => ({
          version: 2 as const,
          requestId: request.requestId,
          runId: request.runId,
          action: request.action,
          acknowledged: false,
          status: "rejected" as const,
          deliveryStatus: "queued" as const,
          sequence,
          nativeRequestId: null,
          message: "Control delivery was pending when Jingler restarted; it was not resent",
          acknowledgedAt: now()
        }))
        yield* Ref.update(ref, (state) => ({
          ...state,
          controlsLoaded: true,
          controlSequence: restored.sequence,
          controlOutcomes: new Map([
            ...restored.outcomes,
            ...recoveredPending
          ].map((outcome) => [outcome.requestId, outcome])),
          controlReceipts: restored.receipts.slice(-MAX_REPLAY_EVENTS),
          pendingControlRequests: new Map()
        }))
      }))
    : Effect.void

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
      const loaded = yield* Effect.either(ensureControlsLoaded)
      if (loaded._tag === "Left") {
        return {
          version: 2,
          requestId: request.requestId,
          runId: request.runId,
          action: request.action,
          acknowledged: false,
          status: "rejected",
          deliveryStatus: "rejected",
          sequence: 0,
          nativeRequestId: null,
          message: loaded.left.message,
          acknowledgedAt: now()
        }
      }
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
        const pendingControlRequests = new Map(state.pendingControlRequests)
        pendingControlRequests.set(request.requestId, { request, sequence })
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
          pendingControlRequests,
          controlReceipts: [...state.controlReceipts, queued].slice(-MAX_REPLAY_EVENTS)
        }] as const)
      })
      if (registration._tag === "Cached") return registration.outcome
      if (registration._tag === "Pending") return yield* Deferred.await(registration.deferred)
      const queuedPersisted = yield* Effect.either(
        Ref.get(ref).pipe(Effect.flatMap(persistControls))
      )
      if (queuedPersisted._tag === "Left") {
        const rejected: SubagentFleetControlOutcome = {
          version: 2,
          requestId: request.requestId,
          runId: request.runId,
          action: request.action,
          acknowledged: false,
          status: "rejected",
          deliveryStatus: "rejected",
          sequence: registration.sequence,
          nativeRequestId: null,
          message: queuedPersisted.left.message,
          acknowledgedAt: now()
        }
        yield* Ref.update(ref, (state) => {
          const pendingControls = new Map(state.pendingControls)
          pendingControls.delete(request.requestId)
          const pendingControlRequests = new Map(state.pendingControlRequests)
          pendingControlRequests.delete(request.requestId)
          const controlOutcomes = new Map(state.controlOutcomes)
          controlOutcomes.set(request.requestId, rejected)
          return {
            ...state,
            pendingControls,
            pendingControlRequests,
            controlOutcomes
          }
        })
        yield* Deferred.succeed(registration.deferred, rejected)
        return rejected
      }
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
        const pendingControlRequests = new Map(state.pendingControlRequests)
        pendingControlRequests.delete(request.requestId)
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
          pendingControlRequests,
          controlOutcomes,
          controlReceipts: [...state.controlReceipts, receipt].slice(-MAX_REPLAY_EVENTS)
        }
      })
      const saved = yield* Effect.either(
        Ref.get(ref).pipe(Effect.flatMap(persistControls))
      )
      const settled = saved._tag === "Right"
        ? outcome
        : {
            ...outcome,
            acknowledged: false,
            status: "rejected" as const,
            message: `${outcome.message}; audit persistence failed: ${saved.left.message}`
          }
      if (settled !== outcome) {
        yield* Ref.update(ref, (state) => {
          const controlOutcomes = new Map(state.controlOutcomes)
          controlOutcomes.set(request.requestId, settled)
          return { ...state, controlOutcomes }
        })
      }
      yield* Deferred.succeed(registration.deferred, settled)
      return settled
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
      controlsLoaded: journal === undefined,
      controlSequence: 0,
      controlOutcomes: new Map<string, SubagentFleetControlOutcome>(),
      controlReceipts: [],
      pendingControlRequests: new Map(),
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
  now: () => number = Date.now,
  journal?: SubagentControlJournal
) =>
  Layer.scoped(
    SubagentSupervisionService,
    Effect.acquireRelease(
      makeSubagentSupervisionService(parentPiSessionId, now, journal),
      (service) => service.stop
    )
  )
