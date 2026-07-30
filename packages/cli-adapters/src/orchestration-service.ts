import {
  buildPlanExecutionGraph,
  planStageSemanticFingerprint
} from "@jingler/core"
import type {
  CliExecError,
  CliKind,
  PlanExecutionDiagnostic,
  PlanPrdStage,
  PlanStageAssignment,
  StreamEvent,
  WorkerActivity,
  WorkerActivityReset,
  WorkerIdentity,
  WorkerLifecycleStatus,
  WorkerState
} from "@jingler/core"
import {
  Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Ref,
  Stream
} from "effect"
import { createActor, createMachine } from "xstate"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter } from "./adapter.js"
import { classifyProviderFailure } from "./provider-failure.js"
import { releaseSessionRun, reserveSessionRun } from "./run-coordinator.js"

export const MAX_ORCHESTRATION_CONCURRENCY = 4

/**
 * Maximum activity records retained for a late watcher. Overflow drops the
 * oldest record, matching the adversarial-review feed's bounded replay policy.
 */
export const WORKER_ACTIVITY_REPLAY_CAP = 2000
export const WORKER_ACTIVITY_LIVE_CAP = 2048
export const WORKER_ACTIVITY_FEED_CAP = 32
export const WORKER_ACTIVITY_FEED_TTL_MS = 30 * 60 * 1000

export type OrchestrationWorkerStatus = WorkerLifecycleStatus

export type OrchestrationStageStatus =
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "interrupted"
  | "completed"
  | "skipped"

/**
 * The worker lifecycle is deliberately provider-neutral. Harness processes are
 * invoked by the Effect service below; the machine is the source of truth for
 * legal lifecycle transitions and can also be reused by a renderer projection.
 */
export const orchestrationWorkerMachine = createMachine({
  id: "orchestration-worker",
  initial: "queued",
  states: {
    queued: {
      on: {
        START: "running",
        STOP: "interrupted"
      }
    },
    running: {
      on: {
        COMPLETE: "completed",
        BLOCK: "blocked",
        FAIL: "failed",
        STOP: "interrupted"
      }
    },
    blocked: {
      on: {
        RETRY: "queued"
      }
    },
    failed: {
      on: {
        RETRY: "queued"
      }
    },
    interrupted: {
      on: {
        RETRY: "queued"
      }
    },
    completed: {
      type: "final"
    }
  }
})

export type OrchestrationAssignment = PlanStageAssignment
export type OrchestrationStage = PlanPrdStage

export interface OrchestrationWorkerGroup {
  readonly agentId: string
  readonly assignment: OrchestrationAssignment
  readonly stages: ReadonlyArray<OrchestrationStage>
}

export type OrchestrationGraphIssue = PlanExecutionDiagnostic

export type OrchestrationGraphResult =
  | {
      readonly valid: true
      readonly groups: ReadonlyArray<OrchestrationWorkerGroup>
    }
  | {
      readonly valid: false
      readonly issues: ReadonlyArray<OrchestrationGraphIssue>
    }

export class OrchestrationValidationError extends Data.TaggedError(
  "OrchestrationValidationError"
)<{
  readonly message: string
  readonly issues: ReadonlyArray<OrchestrationGraphIssue>
}> {}

export class OrchestrationWorkerNotFoundError extends Data.TaggedError(
  "OrchestrationWorkerNotFoundError"
)<{
  readonly message: string
  readonly planId: string
  readonly agentId: string
}> {}

export class OrchestrationAlreadyRunningError extends Data.TaggedError(
  "OrchestrationAlreadyRunningError"
)<{
  readonly message: string
  readonly planId: string
}> {}

export class OrchestrationPersistenceError extends Data.TaggedError(
  "OrchestrationPersistenceError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Validate the stage DAG and turn it into maximally parallel worker groups.
 *
 * Dependencies are treated as undirected for ownership: if B depends on A they
 * share one agent and resume identity. File overlap and an explicitly reused
 * agent id also union stages. Ordering inside a group remains the directed
 * topological order from the plan.
 */
export const buildOrchestrationGroups = (
  stages: ReadonlyArray<OrchestrationStage>
): OrchestrationGraphResult => {
  const graph = buildPlanExecutionGraph(stages, { requireAssignments: true })
  if (!graph.valid) return { valid: false, issues: graph.diagnostics }
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const groups = graph.groups.flatMap((group): ReadonlyArray<OrchestrationWorkerGroup> => {
    if (group.assignment === null) return []
    const members = group.stageIds
      .map((id) => stageById.get(id))
      .filter((stage): stage is OrchestrationStage => stage !== undefined)
    return [{
      agentId: group.assignment.agentId,
      assignment: group.assignment,
      stages: members
    }]
  })
  return { valid: true, groups }
}

export interface OrchestrationEvidence {
  readonly criterionId: string
  readonly status: "passed" | "failed"
  readonly evidence: string
  readonly stageId: string
  readonly agentId: string
  readonly stageFingerprint: string
}

export interface OrchestrationWorkerUpdate {
  readonly sessionId: string
  readonly planId: string
  readonly agentId: string
  readonly ownerId: string
  readonly stageIds: ReadonlyArray<string>
  readonly harness: CliKind
  readonly model: string | null
  readonly status: OrchestrationWorkerStatus
  readonly resumeId: string | null
  readonly message: string | null
  readonly attempt: number
}

export interface OrchestrationStageUpdate {
  readonly sessionId: string
  readonly planId: string
  readonly agentId: string
  readonly stageId: string
  readonly status: OrchestrationStageStatus
  readonly message: string | null
  readonly stageFingerprint: string
}

export interface OrchestrationCheckpoint {
  readonly agentId: string
  readonly state: OrchestrationWorkerStatus
  readonly completedStageIds: ReadonlyArray<string>
  readonly resumeId: string | null
  readonly message: string | null
  readonly attempt: number
}

export const recoverOrchestrationCheckpoints = (
  checkpoints: ReadonlyArray<OrchestrationCheckpoint>
): ReadonlyArray<OrchestrationCheckpoint> =>
  checkpoints.map((checkpoint) =>
    checkpoint.state === "running"
      ? {
          ...checkpoint,
          state: "interrupted",
          message: "The desktop process stopped while this worker was running."
        }
      : checkpoint
  )

export interface OrchestrationCallbacks {
  readonly onWorkerState?: (
    update: OrchestrationWorkerUpdate
  ) => Effect.Effect<void, OrchestrationPersistenceError, never>
  readonly onStageState?: (
    update: OrchestrationStageUpdate
  ) => Effect.Effect<void, OrchestrationPersistenceError, never>
  readonly onEvent?: (
    agentId: string,
    stageId: string,
    event: StreamEvent
  ) => Effect.Effect<void, never, never>
  readonly onEvidence?: (
    evidence: OrchestrationEvidence
  ) => Effect.Effect<void, OrchestrationPersistenceError, never>
  /**
   * Persist this beside the canonical plan. The orchestration service emits a
   * checkpoint at every mechanical state change but stays independent of the
   * storage environment used by the desktop runtime.
   */
  readonly onCheckpoint?: (
    checkpoint: OrchestrationCheckpoint
  ) => Effect.Effect<void, OrchestrationPersistenceError, never>
}

export interface OrchestrationSessionSpecRequest {
  readonly ownerId: string
  readonly group: OrchestrationWorkerGroup
  readonly stage: OrchestrationStage
  readonly prompt: string
  readonly resumeId: string | null
}

export interface OrchestrationExecuteInput {
  readonly sessionId: string
  readonly planId: string
  readonly producingChatId: string
  readonly planRevision: number
  readonly stages: ReadonlyArray<OrchestrationStage>
  readonly checkpoints?: ReadonlyArray<OrchestrationCheckpoint>
  readonly maxConcurrency?: number
  /** Run only these logical workers, used by durable per-worker retry. */
  readonly agentIds?: ReadonlyArray<string>
  readonly makeSessionSpec: (request: OrchestrationSessionSpecRequest) => SessionSpec
  /**
   * Re-read a stage from the latest canonical revision at its execution
   * boundary. This lets an in-flight worker pick up orchestrator amendments
   * without changing its logical identity or restarting independent siblings.
   */
  readonly refreshStage?: (
    agentId: string,
    stageId: string
  ) => Effect.Effect<PlanPrdStage | null, never, never>
  readonly callbacks?: OrchestrationCallbacks
}

export interface OrchestrationWorkerResult {
  readonly agentId: string
  readonly ownerId: string
  readonly status: OrchestrationWorkerStatus
  readonly completedStageIds: ReadonlyArray<string>
  readonly resumeId: string | null
  readonly message: string | null
  readonly evidence: ReadonlyArray<OrchestrationEvidence>
  readonly attempt: number
}

export interface OrchestrationExecutionReport {
  readonly planId: string
  readonly planRevision: number
  readonly workers: ReadonlyArray<OrchestrationWorkerResult>
}

const planRunKeyFor = (sessionId: string, planId: string): string =>
  `${sessionId}\u0000${planId}`

const ownerIdFor = (
  sessionId: string,
  planId: string,
  agentId: string
): string => `session:${sessionId}:plan:${planId}:agent:${agentId}`

const workerStatusFrom = (value: unknown): OrchestrationWorkerStatus => {
  switch (value) {
    case "queued":
    case "running":
    case "blocked":
    case "failed":
    case "interrupted":
    case "completed":
      return value
    default:
      throw new Error(`Unexpected orchestration worker state: ${String(value)}`)
  }
}

const workerPrompt = (
  input: OrchestrationExecuteInput,
  group: OrchestrationWorkerGroup,
  stage: OrchestrationStage
): string => `[[orchestration-worker]]
You are worker ${group.agentId} executing an approved Jingler plan.

Plan: ${input.planId}, revision ${input.planRevision}
Stage: ${stage.id} — ${stage.title}
Intent: ${stage.intent}

Stage specification:
${stage.markdown}

Complete only this stage in the shared worktree. Dependencies assigned to you run
before this stage. Do not edit the canonical plan directly; Jingler records
mechanical progress. Run proportionate verification. Finish with one line per
criterion you verified:
PLAN_RESULT criterion=<id> status=<passed|failed> evidence=<concise observable evidence>

Criteria: ${stage.acceptance.map((criterion) => criterion.id).join(", ")}`

interface ParsedStageEvidence {
  readonly evidence: ReadonlyArray<OrchestrationEvidence>
  readonly structuralErrors: ReadonlyArray<string>
  readonly verificationErrors: ReadonlyArray<string>
}

const evidenceFrom = (
  output: string,
  stage: OrchestrationStage,
  agentId: string,
  stageFingerprint: string
): ParsedStageEvidence => {
  const evidence: Array<OrchestrationEvidence> = []
  const seen = new Set<string>()
  const allowed = new Set(
    stage.acceptance
      .filter((criterion) => criterion.status !== "waived")
      .map((criterion) => criterion.id)
  )
  const structuralErrors: Array<string> = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("PLAN_RESULT")) continue
    const match =
      /^PLAN_RESULT criterion=(\S+) status=(passed|failed) evidence=(\S.*)$/.exec(
        line.trim()
      )
    if (match === null) {
      structuralErrors.push("A PLAN_RESULT line was malformed.")
      continue
    }
    const criterionId = match[1]
    const status = match[2]
    const detail = match[3]
    if (
      criterionId === undefined ||
      (status !== "passed" && status !== "failed") ||
      detail === undefined
    ) {
      structuralErrors.push("A PLAN_RESULT line was malformed.")
      continue
    }
    if (!allowed.has(criterionId)) {
      structuralErrors.push(
        `Criterion "${criterionId}" does not belong to stage "${stage.id}".`
      )
      continue
    }
    if (seen.has(criterionId)) {
      structuralErrors.push(
        `Criterion "${criterionId}" was reported more than once.`
      )
      continue
    }
    seen.add(criterionId)
    evidence.push({
      criterionId,
      status,
      evidence: detail.trim(),
      stageId: stage.id,
      agentId,
      stageFingerprint
    })
  }
  const verificationErrors = [
    ...[...allowed]
      .filter((criterionId) => !seen.has(criterionId))
      .map(
        (criterionId) =>
          `Criterion "${criterionId}" has no PLAN_RESULT evidence.`
      ),
    ...evidence
      .filter((item) => item.status !== "passed")
      .map((item) => `Criterion "${item.criterionId}" was reported failed.`)
  ]
  return { evidence, structuralErrors, verificationErrors }
}

const boundedConcurrency = (requested: number | undefined): number =>
  Math.max(1, Math.min(MAX_ORCHESTRATION_CONCURRENCY, Math.floor(requested ?? MAX_ORCHESTRATION_CONCURRENCY)))

const activityScope = (
  activity: WorkerActivity
): {
  readonly sessionId: string
  readonly planId: string
  readonly producingChatId: string
} =>
  activity._tag === "Reset"
    ? activity
    : activity.worker

type WorkerActivityScope = ReturnType<typeof activityScope>

interface SequencedWorkerActivity {
  readonly sequence: number
  readonly activity: WorkerActivity
}

interface WorkerActivityFeed {
  readonly hub: PubSub.PubSub<SequencedWorkerActivity>
  readonly buffer: Ref.Ref<ReadonlyArray<SequencedWorkerActivity>>
  readonly snapshot: Ref.Ref<WorkerActivityReset | null>
  readonly gate: Effect.Semaphore
  readonly nextSequence: Ref.Ref<number>
  readonly subscribers: Ref.Ref<number>
  readonly lastTouchedAt: Ref.Ref<number>
}

const sameActivityScope = (
  left: WorkerActivityScope,
  right: WorkerActivityScope
): boolean =>
  left.sessionId === right.sessionId &&
  left.planId === right.planId &&
  left.producingChatId === right.producingChatId

const replaceWorkerState = (
  workers: ReadonlyArray<WorkerState>,
  next: WorkerState
): ReadonlyArray<WorkerState> => {
  const index = workers.findIndex(
    (state) => state.worker.agentId === next.worker.agentId
  )
  if (index < 0) return [...workers, next]
  if (workers[index]!.worker.attempt > next.worker.attempt) return workers
  return [...workers.slice(0, index), next, ...workers.slice(index + 1)]
}

const snapshotAfterActivity = (
  current: WorkerActivityReset | null,
  activity: WorkerActivity
): WorkerActivityReset => {
  const scope = activityScope(activity)
  const inCurrentScope =
    current !== null && sameActivityScope(current, scope)
  const workers = inCurrentScope ? current.workers : []

  if (activity._tag === "Reset") {
    return {
      ...activity,
      mode: "replace",
      workers:
        activity.mode === "replace" || !inCurrentScope
          ? activity.workers
          : activity.workers.reduce(replaceWorkerState, workers)
    }
  }

  const state: WorkerState =
    activity._tag === "State"
      ? {
          worker: activity.worker,
          status: activity.status,
          message: activity.message
        }
      : {
          worker: activity.worker,
          status: "running",
          message: null
        }
  const existing = workers.find(
    (candidate) =>
      candidate.worker.agentId === activity.worker.agentId &&
      candidate.worker.attempt >= activity.worker.attempt
  )
  return {
    _tag: "Reset",
    sessionId: scope.sessionId,
    planId: scope.planId,
    producingChatId: scope.producingChatId,
    mode: "replace",
    workers:
      activity._tag === "HarnessEvent" && existing !== undefined
        ? workers
        : replaceWorkerState(workers, state)
  }
}

const activityAgentId = (activity: WorkerActivity): string | null =>
  activity._tag === "Reset" ? null : activity.worker.agentId

const appendBufferedActivity = (
  buffer: ReadonlyArray<SequencedWorkerActivity>,
  item: SequencedWorkerActivity
): ReadonlyArray<SequencedWorkerActivity> =>
  buffer.length >= WORKER_ACTIVITY_REPLAY_CAP
    ? [...buffer.slice(1), item]
    : [...buffer, item]

const hasLiveWorkers = (snapshot: WorkerActivityReset | null): boolean =>
  snapshot?.workers.some(
    ({ status }) => status === "queued" || status === "running"
  ) ?? false

const workerIdentityFor = (
  input: OrchestrationExecuteInput,
  group: OrchestrationWorkerGroup,
  attempt: number
): WorkerIdentity => ({
  sessionId: input.sessionId,
  planId: input.planId,
  producingChatId: input.producingChatId,
  agentId: group.agentId,
  stageIds: group.stages.map((stage) => stage.id),
  harness: group.assignment.cli,
  model: group.assignment.model,
  attempt
})

export class OrchestrationService extends Effect.Service<OrchestrationService>()(
  "@jingler/OrchestrationService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const adapter = yield* CliAdapter
      const cancelled = yield* Ref.make(new Set<string>())
      const liveAdapterFibers = yield* Ref.make(
        new Map<string, Fiber.RuntimeFiber<void, CliExecError>>()
      )
      const workerSettled = yield* Ref.make(
        new Map<string, Deferred.Deferred<void>>()
      )
      const activePlans = yield* Ref.make(new Set<string>())
      const activityFeeds = yield* Ref.make(
        new Map<string, WorkerActivityFeed>()
      )
      const activityFeedsGate = yield* Effect.makeSemaphore(1)

      /**
       * One bounded activity feed per recently active session. Inactive entries
       * expire lazily and the LRU cap prevents the desktop process retaining one
       * replay forever for every session it has ever opened.
       */
      const makeActivityFeed = (now: number): Effect.Effect<WorkerActivityFeed> =>
        Effect.gen(function* () {
          const hub = yield* PubSub.sliding<SequencedWorkerActivity>(
            WORKER_ACTIVITY_LIVE_CAP
          )
          const buffer = yield* Ref.make<
            ReadonlyArray<SequencedWorkerActivity>
          >([])
          const snapshot = yield* Ref.make<WorkerActivityReset | null>(null)
          const gate = yield* Effect.makeSemaphore(1)
          const nextSequence = yield* Ref.make(0)
          const subscribers = yield* Ref.make(0)
          const lastTouchedAt = yield* Ref.make(now)
          return {
            hub,
            buffer,
            snapshot,
            gate,
            nextSequence,
            subscribers,
            lastTouchedAt
          }
        })

      const canEvictActivityFeed = (
        feed: WorkerActivityFeed,
        now: number,
        requireExpiry: boolean
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if ((yield* Ref.get(feed.subscribers)) > 0) return false
          if (hasLiveWorkers(yield* Ref.get(feed.snapshot))) return false
          if (!requireExpiry) return true
          return (
            now - (yield* Ref.get(feed.lastTouchedAt)) >=
            WORKER_ACTIVITY_FEED_TTL_MS
          )
        })

      const activityFor = (
        sessionId: string
      ): Effect.Effect<WorkerActivityFeed> =>
        activityFeedsGate.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const current = yield* Ref.get(activityFeeds)
            const expired: Array<string> = []
            for (const [id, feed] of current) {
              if (yield* canEvictActivityFeed(feed, now, true)) {
                expired.push(id)
              }
            }
            const retained = new Map(current)
            for (const id of expired) {
              const feed = retained.get(id)
              if (feed === undefined) continue
              retained.delete(id)
              yield* feed.hub.shutdown
            }

            const existing = retained.get(sessionId)
            if (existing !== undefined) {
              yield* Ref.set(existing.lastTouchedAt, now)
              if (expired.length > 0) yield* Ref.set(activityFeeds, retained)
              return existing
            }

            if (retained.size >= WORKER_ACTIVITY_FEED_CAP) {
              const candidates: Array<{
                readonly id: string
                readonly feed: WorkerActivityFeed
                readonly touchedAt: number
              }> = []
              for (const [id, feed] of retained) {
                if (yield* canEvictActivityFeed(feed, now, false)) {
                  candidates.push({
                    id,
                    feed,
                    touchedAt: yield* Ref.get(feed.lastTouchedAt)
                  })
                }
              }
              candidates.sort(
                (left, right) => left.touchedAt - right.touchedAt
              )
              while (
                retained.size >= WORKER_ACTIVITY_FEED_CAP &&
                candidates.length > 0
              ) {
                const oldest = candidates.shift()
                if (oldest === undefined) break
                retained.delete(oldest.id)
                yield* oldest.feed.hub.shutdown
              }
            }

            const created = yield* makeActivityFeed(now)
            retained.set(sessionId, created)
            yield* Ref.set(activityFeeds, retained)
            return created
          })
        )

      const publishSequenced = (
        live: WorkerActivityFeed,
        activity: WorkerActivity
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sequence = yield* Ref.getAndUpdate(
            live.nextSequence,
            (value) => value + 1
          )
          const item = { sequence, activity } satisfies SequencedWorkerActivity
          const currentSnapshot = yield* Ref.get(live.snapshot)
          yield* Ref.set(
            live.snapshot,
            snapshotAfterActivity(currentSnapshot, activity)
          )
          if (activity._tag === "Reset") {
            const resetIds = new Set(
              activity.workers.map(({ worker }) => worker.agentId)
            )
            yield* Ref.update(live.buffer, (buffer) =>
              activity.mode === "replace"
                ? []
                : buffer.filter((candidate) => {
                    const agentId = activityAgentId(candidate.activity)
                    return agentId === null || !resetIds.has(agentId)
                  })
            )
          } else {
            yield* Ref.update(live.buffer, (buffer) =>
              appendBufferedActivity(buffer, item)
            )
          }
          yield* Ref.set(
            live.lastTouchedAt,
            yield* Clock.currentTimeMillis
          )
          yield* PubSub.publish(live.hub, item)
        })

      const publishActivity = (
        activity: WorkerActivity
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const scope = activityScope(activity)
          const live = yield* activityFor(scope.sessionId)
          yield* live.gate.withPermits(1)(
            Effect.gen(function* () {
              const snapshot = yield* Ref.get(live.snapshot)
              if (
                snapshot === null ||
                !sameActivityScope(snapshot, scope)
              ) return
              yield* publishSequenced(live, activity)
            })
          )
        })

      const resetWorkerActivity = (
        input: OrchestrationExecuteInput,
        workers: ReadonlyArray<WorkerState>,
        requestedMode: "replace" | "patch",
        baseline: ReadonlyArray<WorkerState>
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const live = yield* activityFor(input.sessionId)
          yield* live.gate.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(live.snapshot)
              const scope = {
                sessionId: input.sessionId,
                planId: input.planId,
                producingChatId: input.producingChatId
              }
              const canPatch =
                requestedMode === "patch" &&
                current !== null &&
                sameActivityScope(current, scope)
              const activity = {
                _tag: "Reset",
                ...scope,
                mode: canPatch ? "patch" : "replace",
                workers: canPatch
                  ? workers
                  : workers.reduce(replaceWorkerState, baseline)
              } satisfies WorkerActivityReset
              yield* publishSequenced(live, activity)
            })
          )
        })

      const replayFrame = (
        live: WorkerActivityFeed,
        requested: WorkerActivityScope
      ): Effect.Effect<{
        readonly activities: ReadonlyArray<WorkerActivity>
        readonly lastSequence: number
      }> =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(live.snapshot)
          const buffer = yield* Ref.get(live.buffer)
          const nextSequence = yield* Ref.get(live.nextSequence)
          if (
            snapshot === null ||
            !sameActivityScope(snapshot, requested)
          ) {
            return { activities: [], lastSequence: nextSequence - 1 }
          }
          return {
            activities: [
              snapshot,
              ...buffer
                .filter(({ activity }) =>
                  sameActivityScope(activityScope(activity), requested)
                )
                .map(({ activity }) => activity)
            ],
            lastSequence: nextSequence - 1
          }
        })

      const watch = (
        sessionId: string,
        planId: string,
        chatId: string
      ): Stream.Stream<WorkerActivity> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const live = yield* activityFor(sessionId)
            yield* Effect.acquireRelease(
              Ref.update(live.subscribers, (count) => count + 1),
              () => Ref.update(live.subscribers, (count) => Math.max(0, count - 1))
            )
            const requested = {
              sessionId,
              planId,
              producingChatId: chatId
            }
            return yield* live.gate.withPermits(1)(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(live.hub)
                const replay = yield* replayFrame(live, requested)
                const lastSeen = yield* Ref.make(replay.lastSequence)
                const tail = Stream.fromQueue(subscription).pipe(
                  Stream.mapEffect((item) =>
                    Effect.gen(function* () {
                      const previous = yield* Ref.get(lastSeen)
                      if (item.sequence <= previous) return []
                      if (item.sequence === previous + 1) {
                        yield* Ref.set(lastSeen, item.sequence)
                        return sameActivityScope(
                          activityScope(item.activity),
                          requested
                        )
                          ? [item.activity]
                          : []
                      }
                      const rebuilt = yield* live.gate.withPermits(1)(
                        replayFrame(live, requested)
                      )
                      yield* Ref.set(lastSeen, rebuilt.lastSequence)
                      return rebuilt.activities
                    })
                  ),
                  Stream.flatMap(Stream.fromIterable)
                )
                return Stream.concat(
                  Stream.fromIterable(replay.activities),
                  tail
                )
              })
            )
          })
        )

      const activityFeedCount = (): Effect.Effect<number> =>
        Ref.get(activityFeeds).pipe(Effect.map((feeds) => feeds.size))

      const notifyWorker = (
        callbacks: OrchestrationCallbacks | undefined,
        worker: WorkerIdentity,
        update: OrchestrationWorkerUpdate
      ): Effect.Effect<void, OrchestrationPersistenceError> =>
        publishActivity({
          _tag: "State",
          worker,
          status: update.status,
          message: update.message
        }).pipe(
          Effect.zipRight(
            callbacks?.onWorkerState?.(update) ?? Effect.void
          )
        )

      const notifyStage = (
        callbacks: OrchestrationCallbacks | undefined,
        update: OrchestrationStageUpdate
      ): Effect.Effect<void, OrchestrationPersistenceError> =>
        callbacks?.onStageState?.(update) ?? Effect.void

      const checkpoint = (
        callbacks: OrchestrationCallbacks | undefined,
        value: OrchestrationCheckpoint
      ): Effect.Effect<void, OrchestrationPersistenceError> =>
        callbacks?.onCheckpoint?.(value) ?? Effect.void

      const runGroup = (
        input: OrchestrationExecuteInput,
        group: OrchestrationWorkerGroup,
        initialCompleted: ReadonlySet<string>,
        initialResumeId: string | null,
        attempt: number
      ): Effect.Effect<OrchestrationWorkerResult, OrchestrationPersistenceError> =>
        Effect.gen(function* () {
          const ownerId = ownerIdFor(
            input.sessionId,
            input.planId,
            group.agentId
          )
          const settled = yield* Deferred.make<void>()
          yield* Ref.update(workerSettled, (workers) =>
            new Map(workers).set(ownerId, settled)
          )
          return yield* Effect.gen(function* () {
            const holder = {}
            const machine = createActor(orchestrationWorkerMachine).start()
            const completed = new Set(initialCompleted)
            let resumeId = initialResumeId
            const allEvidence: Array<OrchestrationEvidence> = []
            let message: string | null = null

          const worker = workerIdentityFor(input, group, attempt)
          const workerUpdate = (
            status: OrchestrationWorkerStatus,
            nextMessage: string | null
          ): OrchestrationWorkerUpdate => ({
            sessionId: input.sessionId,
            planId: input.planId,
            agentId: group.agentId,
            ownerId,
            stageIds: group.stages.map((stage) => stage.id),
            harness: group.assignment.cli,
            model: group.assignment.model,
            status,
            resumeId,
            message: nextMessage,
            attempt
          })
          const saveCheckpoint = (
            state: OrchestrationWorkerStatus,
            nextMessage: string | null
          ): Effect.Effect<void, OrchestrationPersistenceError> =>
            checkpoint(input.callbacks, {
              agentId: group.agentId,
              state,
              completedStageIds: [...completed],
              resumeId,
              message: nextMessage,
              attempt
            })

          const queuedStatus = workerStatusFrom(machine.getSnapshot().value)
          yield* notifyWorker(
            input.callbacks,
            worker,
            workerUpdate(queuedStatus, null)
          )
          yield* saveCheckpoint(queuedStatus, null)

          if ((yield* Ref.get(cancelled)).has(ownerId)) {
            machine.send({ type: "STOP" })
            const status = workerStatusFrom(machine.getSnapshot().value)
            message = "Worker stopped before it started."
            yield* notifyWorker(
              input.callbacks,
              worker,
              workerUpdate(status, message)
            )
            yield* saveCheckpoint(status, message)
            machine.stop()
          return {
              agentId: group.agentId,
              ownerId,
              status,
              completedStageIds: [...completed],
              resumeId,
              message,
              evidence: allEvidence,
              attempt
            } satisfies OrchestrationWorkerResult
          }

          const reserved = yield* reserveSessionRun(input.sessionId, ownerId, holder)
          if (!reserved) {
            machine.send({ type: "START" })
            machine.send({ type: "FAIL" })
            const status = workerStatusFrom(machine.getSnapshot().value)
            message = `Worker "${group.agentId}" is already running.`
            yield* notifyWorker(
              input.callbacks,
              worker,
              workerUpdate(status, message)
            )
            yield* saveCheckpoint(status, message)
            machine.stop()
            return {
              agentId: group.agentId,
              ownerId,
              status,
              completedStageIds: [...completed],
              resumeId,
              message,
              evidence: allEvidence,
              attempt
            } satisfies OrchestrationWorkerResult
          }

          machine.send({ type: "START" })
          const runningStatus = workerStatusFrom(machine.getSnapshot().value)
          yield* notifyWorker(
            input.callbacks,
            worker,
            workerUpdate(runningStatus, null)
          )
          yield* saveCheckpoint(runningStatus, null)

          const outcome = yield* Effect.gen(function* () {
            for (const stage of group.stages) {
              if (completed.has(stage.id)) {
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "skipped",
                  message: "Already completed in the latest checkpoint.",
                  stageFingerprint: planStageSemanticFingerprint(stage)
                })
                continue
              }
              const refreshedStage =
                input.refreshStage === undefined
                  ? stage
                  : yield* input.refreshStage(group.agentId, stage.id)
              if (refreshedStage === null) {
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "skipped",
                  message: "Stage removed from the canonical plan before execution.",
                  stageFingerprint: planStageSemanticFingerprint(stage)
                })
                continue
              }
              const latestStage = refreshedStage
              const stageFingerprint =
                planStageSemanticFingerprint(latestStage)
              if ((yield* Ref.get(cancelled)).has(ownerId)) {
                return {
                  status: "interrupted",
                  message: "Worker stopped by the operator."
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }

              yield* notifyStage(input.callbacks, {
                sessionId: input.sessionId,
                planId: input.planId,
                agentId: group.agentId,
                stageId: stage.id,
                status: "running",
                message: null,
                stageFingerprint
              })

              const assistant = yield* Ref.make<ReadonlyArray<string>>([])
              const emittedFailure = yield* Ref.make<string | null>(null)
              const blocker = yield* Ref.make<string | null>(null)
              const persistenceFailure =
                yield* Ref.make<OrchestrationPersistenceError | null>(null)
              const prompt = workerPrompt(input, group, latestStage)
              const requested = input.makeSessionSpec({
                ownerId,
                group,
                stage: latestStage,
                prompt,
                resumeId
              })
              const spec: SessionSpec = {
                ...requested,
                cli: group.assignment.cli,
                model: group.assignment.model,
                prompt,
                resumeId,
                fresh: resumeId === null ? requested.fresh : false,
                unattended: true
              }

              const emit = (event: StreamEvent): Effect.Effect<void> =>
                Effect.gen(function* () {
                  if (event._tag === "Started") {
                    resumeId = event.sessionId
                    const persisted = yield* saveCheckpoint(
                      "running",
                      null
                    ).pipe(Effect.either)
                    if (persisted._tag === "Left") {
                      yield* Ref.set(persistenceFailure, persisted.left)
                      return yield* Effect.interrupt
                    }
                  }
                  if (event._tag === "Assistant") {
                    yield* Ref.update(assistant, (chunks) => [...chunks, event.text])
                  }
                  if (event._tag === "Failed") yield* Ref.set(emittedFailure, event.message)
                  yield* publishActivity({
                    _tag: "HarnessEvent",
                    worker,
                    stageId: stage.id,
                    event
                  })
                  yield* input.callbacks?.onEvent?.(
                    group.agentId,
                    stage.id,
                    event
                  ) ?? Effect.void
                })
              const context: AgentContext = {
                emit,
                canUseTool: () =>
                  Ref.get(blocker).pipe(
                    Effect.map((value) => value === null ? "allow" : "deny")
                  ),
                askQuestion: (request) =>
                  Ref.set(
                    blocker,
                    `Worker asked for operator input: ${request.questions[0]?.question ?? "question"}`
                  ).pipe(Effect.zipRight(Effect.interrupt)),
                proposePlan: () =>
                  Ref.set(blocker, "Worker attempted to replace the approved plan.").pipe(
                    Effect.zipRight(Effect.interrupt)
                  ),
                registerBackgroundStop: () => Effect.void,
                registerTurnSteer: () => Effect.void
              }

              const adapterFiber = yield* Effect.fork(
                adapter.run(ownerId, spec, context)
              )
              yield* Ref.update(liveAdapterFibers, (fibers) =>
                new Map(fibers).set(ownerId, adapterFiber)
              )
              const adapterExit = yield* Fiber.await(adapterFiber).pipe(
                Effect.ensuring(
                  Ref.update(liveAdapterFibers, (fibers) => {
                    if (fibers.get(ownerId) !== adapterFiber) return fibers
                    const next = new Map(fibers)
                    next.delete(ownerId)
                    return next
                  })
                )
              )
              const stopped = (yield* Ref.get(cancelled)).has(ownerId)
              if (stopped) {
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "interrupted",
                  message: "Worker stopped by the operator.",
                  stageFingerprint
                })
                return {
                  status: "interrupted",
                  message: "Worker stopped by the operator."
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }

              const persistenceError = yield* Ref.get(persistenceFailure)
              if (persistenceError !== null) return yield* persistenceError

              const blocked = yield* Ref.get(blocker)
              if (blocked !== null) {
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "blocked",
                  message: blocked,
                  stageFingerprint
                })
                return {
                  status: "blocked",
                  message: blocked
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }

              const failedEvent = yield* Ref.get(emittedFailure)
              const failure =
                Exit.isFailure(adapterExit)
                  ? Option.getOrUndefined(
                      Cause.failureOption(adapterExit.cause)
                    ) ?? Cause.pretty(adapterExit.cause)
                  : failedEvent
              if (failure !== null) {
                const classified = classifyProviderFailure(failure)
                const status =
                  classified.classification === "terminal-operator" ? "blocked" : "failed"
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status,
                  message: classified.message,
                  stageFingerprint
                })
                return {
                  status,
                  message: classified.message
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }

              const stageEvidence = evidenceFrom(
                (yield* Ref.get(assistant)).join("\n"),
                latestStage,
                group.agentId,
                stageFingerprint
              )
              if (stageEvidence.structuralErrors.length > 0) {
                const verificationMessage =
                  stageEvidence.structuralErrors.join(" ")
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "failed",
                  message: verificationMessage,
                  stageFingerprint
                })
                return {
                  status: "failed",
                  message: verificationMessage
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }
              const stageAfterRun =
                input.refreshStage === undefined
                  ? latestStage
                  : yield* input.refreshStage(group.agentId, stage.id)
              const stageAfterRunFingerprint =
                stageAfterRun === null
                  ? null
                  : planStageSemanticFingerprint(stageAfterRun)
              if (
                stageAfterRun === null ||
                stageAfterRunFingerprint !== stageFingerprint
              ) {
                const amendedFingerprint =
                  stageAfterRunFingerprint ?? stageFingerprint
                const amendedMessage =
                  `Stage "${stage.id}" changed while its worker was running; its old results were discarded and the existing worker can resume the amended stage.`
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "interrupted",
                  message: amendedMessage,
                  stageFingerprint: amendedFingerprint
                })
                return {
                  status: "interrupted",
                  message: amendedMessage
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }
              for (const evidence of stageEvidence.evidence) {
                allEvidence.push(evidence)
                yield* input.callbacks?.onEvidence?.(evidence) ?? Effect.void
              }
              if (stageEvidence.verificationErrors.length > 0) {
                const verificationMessage =
                  stageEvidence.verificationErrors.join(" ")
                yield* notifyStage(input.callbacks, {
                  sessionId: input.sessionId,
                  planId: input.planId,
                  agentId: group.agentId,
                  stageId: stage.id,
                  status: "failed",
                  message: verificationMessage,
                  stageFingerprint
                })
                return {
                  status: "failed",
                  message: verificationMessage
                } satisfies {
                  readonly status: OrchestrationWorkerStatus
                  readonly message: string
                }
              }
              completed.add(stage.id)
              yield* notifyStage(input.callbacks, {
                sessionId: input.sessionId,
                planId: input.planId,
                agentId: group.agentId,
                stageId: stage.id,
                status: "completed",
                message: null,
                stageFingerprint
              })
              yield* saveCheckpoint("running", null)
            }
            return {
              status: "completed",
              message: null
            } satisfies {
              readonly status: OrchestrationWorkerStatus
              readonly message: string | null
            }
          }).pipe(Effect.ensuring(releaseSessionRun(input.sessionId, ownerId, holder)))

          message = outcome.message
          if (outcome.status === "completed") machine.send({ type: "COMPLETE" })
          else if (outcome.status === "blocked") machine.send({ type: "BLOCK" })
          else if (outcome.status === "failed") machine.send({ type: "FAIL" })
          else machine.send({ type: "STOP" })

          const status = workerStatusFrom(machine.getSnapshot().value)
          yield* notifyWorker(
            input.callbacks,
            worker,
            workerUpdate(status, message)
          )
          yield* saveCheckpoint(status, message)
          machine.stop()
            return {
              agentId: group.agentId,
              ownerId,
              status,
              completedStageIds: [...completed],
              resumeId,
              message,
              evidence: allEvidence,
              attempt
            } satisfies OrchestrationWorkerResult
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.update(liveAdapterFibers, (fibers) => {
                  const next = new Map(fibers)
                  next.delete(ownerId)
                  return next
                })
                yield* Ref.update(workerSettled, (workers) => {
                  const next = new Map(workers)
                  next.delete(ownerId)
                  return next
                })
                yield* Deferred.succeed(settled, undefined)
              })
            )
          )
        })

      const execute = (
        input: OrchestrationExecuteInput
      ): Effect.Effect<
        OrchestrationExecutionReport,
        | OrchestrationValidationError
        | OrchestrationWorkerNotFoundError
        | OrchestrationAlreadyRunningError
        | OrchestrationPersistenceError
      > =>
        Effect.gen(function* () {
          const planRunKey = planRunKeyFor(input.sessionId, input.planId)
          const graph = buildOrchestrationGroups(input.stages)
          if (!graph.valid) {
            return yield* new OrchestrationValidationError({
              message: graph.issues.map((issue) => issue.message).join("\n"),
              issues: graph.issues
            })
          }
          const requestedAgents =
            input.agentIds === undefined ? null : new Set(input.agentIds)
          const groups =
            requestedAgents === null
              ? graph.groups
              : graph.groups.filter((group) =>
                  requestedAgents.has(group.agentId)
                )
          if (
            requestedAgents !== null &&
            groups.length !== requestedAgents.size
          ) {
            const found = new Set(groups.map((group) => group.agentId))
            const missing = [...requestedAgents].find(
              (agentId) => !found.has(agentId)
            )!
            return yield* new OrchestrationWorkerNotFoundError({
              message: `No worker "${missing}" exists for plan "${input.planId}".`,
              planId: input.planId,
              agentId: missing
            })
          }
          const claimed = yield* Ref.modify(activePlans, (plans) =>
            plans.has(planRunKey)
              ? [false, plans]
              : [true, new Set(plans).add(planRunKey)]
          )
          if (!claimed) {
            return yield* new OrchestrationAlreadyRunningError({
              message: `Plan "${input.planId}" already has live workers. Wait for them to settle before approving or retrying it again.`,
              planId: input.planId
            })
          }
          return yield* Effect.gen(function* () {
            const checkpoints = new Map(
              recoverOrchestrationCheckpoints(input.checkpoints ?? []).map(
                (value) => [value.agentId, value]
              )
            )
            const baseline = graph.groups.map((group): WorkerState => {
              const checkpoint = checkpoints.get(group.agentId)
              return {
                worker: workerIdentityFor(
                  input,
                  group,
                  checkpoint?.attempt ?? 0
                ),
                status: checkpoint?.state ?? "queued",
                message: checkpoint?.message ?? null
              }
            })
            yield* resetWorkerActivity(
              input,
              groups.map((group) => ({
                worker: workerIdentityFor(
                  input,
                  group,
                  (checkpoints.get(group.agentId)?.attempt ?? 0) + 1
                ),
                status: "queued",
                message: null
              })),
              requestedAgents === null ? "replace" : "patch",
              baseline
            )
            for (const group of groups) {
              const ownerId = ownerIdFor(
                input.sessionId,
                input.planId,
                group.agentId
              )
              yield* Ref.update(cancelled, (current) => {
                const next = new Set(current)
                next.delete(ownerId)
                return next
              })
            }
            const workers = yield* Effect.forEach(
              groups,
              (group) => {
                const prior = checkpoints.get(group.agentId)
                return runGroup(
                  input,
                  group,
                  new Set(prior?.completedStageIds ?? []),
                  prior?.resumeId ?? null,
                  (prior?.attempt ?? 0) + 1
                )
              },
              { concurrency: boundedConcurrency(input.maxConcurrency) }
            )
            return {
              planId: input.planId,
              planRevision: input.planRevision,
              workers
            }
          }).pipe(
            Effect.ensuring(
              Ref.update(activePlans, (plans) => {
                const next = new Set(plans)
                next.delete(planRunKey)
                return next
              })
            )
          )
        })

      const stopWorker = (request: {
        readonly sessionId: string
        readonly planId: string
        readonly agentId: string
      }): Effect.Effect<void> => {
        const ownerId = ownerIdFor(
          request.sessionId,
          request.planId,
          request.agentId
        )
        return Effect.gen(function* () {
          yield* Ref.update(
            cancelled,
            (current) => new Set(current).add(ownerId)
          )
          yield* adapter.stop(ownerId).pipe(Effect.ignore)
          const fiber = (yield* Ref.get(liveAdapterFibers)).get(ownerId)
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          const settled = (yield* Ref.get(workerSettled)).get(ownerId)
          if (settled !== undefined) yield* Deferred.await(settled)
        })
      }

      const isPlanRunning = (
        sessionId: string,
        planId: string
      ): Effect.Effect<boolean> =>
        Ref.get(activePlans).pipe(
          Effect.map((plans) => plans.has(planRunKeyFor(sessionId, planId)))
        )

      return {
        execute,
        stopWorker,
        isPlanRunning,
        watch,
        activityFeedCount
      }
    })
  }
) {}
