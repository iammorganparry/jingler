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
import { migrateLegacySubagentControlJournal } from "../migration/legacy-subagent-control-journal.js"
import {
  emptySubagentRunTree,
  reduceSubagentFleetEvent,
  type SubagentRunTreeContext
} from "./subagent-run-tree-reducer.js"

const MAX_REPLAY_EVENTS = 256
const MAX_TRANSCRIPT_FILES = 32
const ControlJournalFields = {
  version: Schema.Literal(2),
  sequence: Schema.Number,
  pending: Schema.Array(Schema.Struct({
    request: SubagentFleetControlRequest,
    sequence: Schema.Number
  })),
  outcomes: Schema.Array(SubagentFleetControlOutcome),
  requests: Schema.optional(Schema.Array(SubagentFleetControlRequest)),
  receipts: Schema.Array(SubagentControlReceipt)
}
const ControlJournal = Schema.Struct({ ...ControlJournalFields, parentRuntimeSessionId: Schema.String })

export interface SubagentControlJournal {
  readonly load: Effect.Effect<typeof ControlJournal.Type, Error>
  readonly save: (journal: typeof ControlJournal.Type) => Effect.Effect<void, Error>
}

export const makeSubagentControlJournal = (input: {
  readonly asyncDir: string
  readonly parentRuntimeSessionId: string
}): SubagentControlJournal => {
  const key = createHash("sha256").update(input.parentRuntimeSessionId).digest("hex")
  const directory = join(input.asyncDir, ".jingler-supervision")
  const path = join(directory, `${key}.json`)
  const empty = {
    version: 2 as const,
    parentRuntimeSessionId: input.parentRuntimeSessionId,
    sequence: 0,
    pending: [],
    outcomes: [],
    requests: [],
    receipts: []
  }
  return {
    load: Effect.tryPromise({
      try: async () => {
        try {
          const decoded = await Schema.decodeUnknownPromise(ControlJournal)(
            migrateLegacySubagentControlJournal(JSON.parse(await readFile(path, "utf8"))),
            { onExcessProperty: "error" }
          )
          if (decoded.parentRuntimeSessionId !== input.parentRuntimeSessionId) {
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
  | { readonly _tag: "Conflict"; readonly outcome: SubagentFleetControlOutcome }
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
  readonly transcriptFiles: ReadonlyMap<string, string>
  readonly controlsLoaded: boolean
  readonly controlSequence: number
  readonly controlOutcomes: ReadonlyMap<string, SubagentFleetControlOutcome>
  readonly controlRequests: ReadonlyMap<string, SubagentFleetControlRequest>
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
  readonly transcriptFile: (runId: string) => Effect.Effect<string | null>
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

const sameControlRequest = (
  left: SubagentFleetControlRequest,
  right: SubagentFleetControlRequest
): boolean =>
  left.version === right.version &&
  left.requestId === right.requestId &&
  left.parentRuntimeSessionId === right.parentRuntimeSessionId &&
  left.runId === right.runId &&
  left.action === right.action &&
  left.message === right.message &&
  left.replyTo === right.replyTo

export const makeSubagentSupervisionService = (
  parentRuntimeSessionId: string,
  now: () => number = Date.now,
  journal?: SubagentControlJournal
): Effect.Effect<SubagentSupervisionServiceShape> => Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<SupervisionState>({
    tree: emptySubagentRunTree(parentRuntimeSessionId),
    eventLog: [],
    registryRevision: 0,
    childSequences: new Map(),
    asyncStarts: new Map(),
    durableNodeIds: new Set(),
    transcriptFiles: new Map(),
    controlsLoaded: journal === undefined,
    controlSequence: 0,
    controlOutcomes: new Map(),
    controlRequests: new Map(),
    controlReceipts: [],
    pendingControlRequests: new Map(),
    pendingControls: new Map(),
    started: false,
    unsubscribes: []
  })
  const controlGate = yield* Effect.makeSemaphore(1)
  const journalGate = yield* Effect.makeSemaphore(1)
  const loadGate = yield* Effect.makeSemaphore(1)

  const modify = <A>(f: (state: SupervisionState) => readonly [A, SupervisionState]) =>
    Ref.modify(ref, f)
  const persistControls = (state: SupervisionState): Effect.Effect<void, Error> =>
    journal?.save({
      version: 2,
      parentRuntimeSessionId,
      sequence: state.controlSequence,
      pending: [...state.pendingControlRequests.values()].slice(-MAX_REPLAY_EVENTS),
      outcomes: [...state.controlOutcomes.values()].slice(-MAX_REPLAY_EVENTS),
      requests: [...state.controlRequests.values()].slice(-MAX_REPLAY_EVENTS),
      receipts: state.controlReceipts.slice(-MAX_REPLAY_EVENTS)
    }) ?? Effect.void
  const persistCurrentControls = journalGate.withPermits(1)(
    Ref.get(ref).pipe(Effect.flatMap(persistControls))
  )
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
          controlRequests: new Map([
            ...(restored.requests ?? []),
            ...restored.pending.map(({ request }) => request)
          ].map((request) => [request.requestId, request])),
          controlReceipts: restored.receipts.slice(-MAX_REPLAY_EVENTS),
          pendingControlRequests: new Map()
        }))
      }))
    : Effect.void

  return {
    state: Ref.get(ref),
    publish: (event) => Ref.update(ref, (state) => {
      const transcriptFiles = new Map(state.transcriptFiles)
          return updateSupervisionTree(event,
        transcriptFiles, state)
        }),
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
          id: subagentFleetNodeId(parentRuntimeSessionId, subagentId),
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
    transcriptFile: (runId) => Ref.get(ref).pipe(
      Effect.map((state) => state.transcriptFiles.get(runId) ?? null)
    ),
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
        const conflict = (sequence: number): ControlRegistration => ({
          _tag: "Conflict",
          outcome: {
            version: 2,
            requestId: request.requestId,
            runId: request.runId,
            action: request.action,
            acknowledged: false,
            status: "rejected",
            deliveryStatus: "rejected",
            sequence,
            nativeRequestId: null,
            message: "Control request ID cannot be verified against the original payload",
            acknowledgedAt: now()
          }
        })
        const cached = state.controlOutcomes.get(request.requestId)
        if (cached) {
          const original = state.controlRequests.get(request.requestId)
          return Effect.succeed([
                  cachedControlRegistration(original, request, cached, conflict),
            state
          ] as const)
        }
        const pending = state.pendingControls.get(request.requestId)
        if (pending) {
          const original = state.pendingControlRequests.get(request.requestId)
          return Effect.succeed([
                  pendingControlRegistration(original, request, pending, conflict),
            state
          ] as const)
        }
        const sequence = state.controlSequence + 1
        const pendingControls = new Map(state.pendingControls)
        pendingControls.set(request.requestId, candidate)
        const pendingControlRequests = new Map(state.pendingControlRequests)
        pendingControlRequests.set(request.requestId, { request, sequence })
        const controlRequests = new Map(state.controlRequests)
        controlRequests.set(request.requestId, request)
        const queued: SubagentControlReceipt = {
          version: 2,
          messageId: request.requestId,
          parentRuntimeSessionId,
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
          controlRequests,
          controlReceipts: [...state.controlReceipts, queued].slice(-MAX_REPLAY_EVENTS)
        }] as const)
      })
          return yield* persistQueuedControl(
            registration,
            persistCurrentControls,
            request,
            now,
            ref,
            controlGate,
            execute,
            parentRuntimeSessionId
          )
        }),
      controlReceipts: Ref.get(ref).pipe(Effect.map(({ controlReceipts }) => controlReceipts)),
      start: (subscribe) =>
        SynchronizedRef.modifyEffect(ref, (state) => {
          if (state.started) return Effect.succeed([false, state] as const)
          return Effect.sync(
            () =>
              [
                true,
                {
                  ...state,
                  started: true,
                  unsubscribes: subscribe()
                }
              ] as const
          )
        }),
      stop: Ref.modify(
        ref,
        (state) =>
          [
            state.unsubscribes,
            {
              ...state,
              tree: emptySubagentRunTree(parentRuntimeSessionId),
              eventLog: [],
              registryRevision: 0,
              childSequences: new Map<string, number>(),
              asyncStarts: new Map<string, SubagentStartRecord>(),
              durableNodeIds: new Set<string>(),
              transcriptFiles: state.transcriptFiles,
              controlsLoaded: journal === undefined,
              controlSequence: 0,
              controlOutcomes: new Map<string, SubagentFleetControlOutcome>(),
              controlRequests: new Map<string, SubagentFleetControlRequest>(),
              controlReceipts: [],
              pendingControlRequests: new Map(),
              pendingControls: new Map<string, Deferred.Deferred<SubagentFleetControlOutcome>>(),
              started: false,
              unsubscribes: []
            }
          ] as const
      ).pipe(
        Effect.flatMap((unsubscribes) =>
          Effect.forEach(unsubscribes, (unsubscribe) => Effect.sync(unsubscribe), { discard: true })
        ),
        Effect.asVoid
      )
    }
  })

export const SubagentSupervisionServiceLive = (
  parentRuntimeSessionId: string,
  now: () => number = Date.now,
  journal?: SubagentControlJournal
) =>
  Layer.scoped(
    SubagentSupervisionService,
    Effect.acquireRelease(
      makeSubagentSupervisionService(parentRuntimeSessionId, now, journal),
      (service) => service.stop
    )
  )

function* persistQueuedControl(
  registration: ControlRegistration,
  persistCurrentControls: Effect.Effect<void, Error, never>,
  request: SubagentFleetControlRequest,
  now: () => number,
  ref: SynchronizedRef.SynchronizedRef<SupervisionState>,
  controlGate: Effect.Semaphore,
  execute: (sequence: number) => Effect.Effect<SubagentFleetControlOutcome>,
  parentRuntimeSessionId: string
) {
  if (registration._tag === "Cached" || registration._tag === "Conflict") {
        return registration.outcome
      }
      if (registration._tag === "Pending") return yield* Deferred.await(registration.deferred)
      const queuedPersisted = yield* Effect.either(persistCurrentControls)
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
  return yield* executeRegisteredControl(
    controlGate,
    execute,
    registration,
    request,
    now,
    ref,
    parentRuntimeSessionId,
    persistCurrentControls
  )
}

function* executeRegisteredControl(
  controlGate: Effect.Semaphore,
  execute: (sequence: number) => Effect.Effect<SubagentFleetControlOutcome>,
  registration: {
    readonly _tag: "Execute"
    readonly deferred: Deferred.Deferred<SubagentFleetControlOutcome>
    readonly sequence: number
  },
  request: SubagentFleetControlRequest,
  now: () => number,
  ref: SynchronizedRef.SynchronizedRef<SupervisionState>,
  parentRuntimeSessionId: string,
  persistCurrentControls: Effect.Effect<void, Error, never>
) {
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
          parentRuntimeSessionId,
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
      const saved = yield* Effect.either(persistCurrentControls)
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
    }

function updateSupervisionTree(
  event: SubagentFleetEvent,
  transcriptFiles: Map<string, string>,
  state: SupervisionState
) {
      if (event._tag === "Upsert" && event.node.sessionFile !== null) {
        transcriptFiles.delete(event.node.runId)
        transcriptFiles.set(event.node.runId, event.node.sessionFile)
        while (transcriptFiles.size > MAX_TRANSCRIPT_FILES) {
          const oldest = transcriptFiles.keys().next().value
          if (oldest === undefined) break
          transcriptFiles.delete(oldest)
        }
      }
  return {
      ...state,
      tree: reduceSubagentFleetEvent(state.tree, event),
      eventLog: [...state.eventLog, event].slice(-MAX_REPLAY_EVENTS),
      registryRevision: Math.max(state.registryRevision, eventRevision(event)),
      transcriptFiles
  }
}

const cachedControlRegistration = (
  original: SubagentFleetControlRequest | undefined,
  request: SubagentFleetControlRequest,
  cached: SubagentFleetControlOutcome,
  conflict: (sequence: number) => ControlRegistration
): ControlRegistration =>
  !original || !sameControlRequest(original, request)
    ? conflict(cached.sequence)
    : { _tag: "Cached", outcome: cached }

const pendingControlRegistration = (
  original:
    | {
        readonly request: SubagentFleetControlRequest
        readonly sequence: number
      }
    | undefined,
  request: SubagentFleetControlRequest,
  pending: Deferred.Deferred<SubagentFleetControlOutcome>,
  conflict: (sequence: number) => ControlRegistration
): ControlRegistration =>
  original && !sameControlRequest(original.request, request)
    ? conflict(original.sequence)
    : { _tag: "Pending", deferred: pending }
