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
  StreamEvent
} from "@jingler/core"
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref
} from "effect"
import { createActor, createMachine } from "xstate"
import type { AgentContext, SessionSpec } from "./adapter.js"
import { CliAdapter } from "./adapter.js"
import { classifyProviderFailure } from "./provider-failure.js"
import { releaseSessionRun, reserveSessionRun } from "./run-coordinator.js"

export const MAX_ORCHESTRATION_CONCURRENCY = 4

export type OrchestrationWorkerStatus =
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "interrupted"
  | "completed"

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
  ) => Effect.Effect<void, never, never>
  readonly onStageState?: (
    update: OrchestrationStageUpdate
  ) => Effect.Effect<void, never, never>
  readonly onEvent?: (
    agentId: string,
    stageId: string,
    event: StreamEvent
  ) => Effect.Effect<void, never, never>
  readonly onEvidence?: (
    evidence: OrchestrationEvidence
  ) => Effect.Effect<void, never, never>
  /**
   * Persist this beside the canonical plan. The orchestration service emits a
   * checkpoint at every mechanical state change but stays independent of the
   * storage environment used by the desktop runtime.
   */
  readonly onCheckpoint?: (
    checkpoint: OrchestrationCheckpoint
  ) => Effect.Effect<void, never, never>
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

interface CachedWorker {
  readonly input: OrchestrationExecuteInput
  readonly group: OrchestrationWorkerGroup
  readonly completedStageIds: ReadonlySet<string>
  readonly resumeId: string | null
  readonly attempt: number
}

const ownerIdFor = (planId: string, agentId: string): string =>
  `plan:${planId}:agent:${agentId}`

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

export class OrchestrationService extends Effect.Service<OrchestrationService>()(
  "@jingler/OrchestrationService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const adapter = yield* CliAdapter
      const cancelled = yield* Ref.make(new Set<string>())
      const cachedWorkers = yield* Ref.make(new Map<string, CachedWorker>())
      const liveAdapterFibers = yield* Ref.make(
        new Map<string, Fiber.RuntimeFiber<void, CliExecError>>()
      )
      const workerSettled = yield* Ref.make(
        new Map<string, Deferred.Deferred<void>>()
      )
      const activePlans = yield* Ref.make(new Set<string>())

      const notifyWorker = (
        callbacks: OrchestrationCallbacks | undefined,
        update: OrchestrationWorkerUpdate
      ): Effect.Effect<void> => callbacks?.onWorkerState?.(update) ?? Effect.void

      const notifyStage = (
        callbacks: OrchestrationCallbacks | undefined,
        update: OrchestrationStageUpdate
      ): Effect.Effect<void> => callbacks?.onStageState?.(update) ?? Effect.void

      const checkpoint = (
        callbacks: OrchestrationCallbacks | undefined,
        value: OrchestrationCheckpoint
      ): Effect.Effect<void> => callbacks?.onCheckpoint?.(value) ?? Effect.void

      const runGroup = (
        input: OrchestrationExecuteInput,
        group: OrchestrationWorkerGroup,
        initialCompleted: ReadonlySet<string>,
        initialResumeId: string | null,
        attempt: number
      ): Effect.Effect<OrchestrationWorkerResult> =>
        Effect.gen(function* () {
          const ownerId = ownerIdFor(input.planId, group.agentId)
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
          ): Effect.Effect<void> =>
            Ref.update(cachedWorkers, (workers) =>
              new Map(workers).set(ownerId, {
                input,
                group,
                completedStageIds: new Set(completed),
                resumeId,
                attempt
              })
            ).pipe(
              Effect.zipRight(
                checkpoint(input.callbacks, {
                  agentId: group.agentId,
                  state,
                  completedStageIds: [...completed],
                  resumeId,
                  message: nextMessage,
                  attempt
                })
              )
            )

          yield* notifyWorker(input.callbacks, workerUpdate("queued", null))
          yield* saveCheckpoint("queued", null)

          if ((yield* Ref.get(cancelled)).has(ownerId)) {
            machine.send({ type: "STOP" })
            message = "Worker stopped before it started."
            yield* notifyWorker(input.callbacks, workerUpdate("interrupted", message))
            yield* saveCheckpoint("interrupted", message)
            machine.stop()
            return {
              agentId: group.agentId,
              ownerId,
              status: "interrupted",
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
            message = `Worker "${group.agentId}" is already running.`
            yield* notifyWorker(input.callbacks, workerUpdate("failed", message))
            yield* saveCheckpoint("failed", message)
            machine.stop()
            return {
              agentId: group.agentId,
              ownerId,
              status: "failed",
              completedStageIds: [...completed],
              resumeId,
              message,
              evidence: allEvidence,
              attempt
            } satisfies OrchestrationWorkerResult
          }

          machine.send({ type: "START" })
          yield* notifyWorker(input.callbacks, workerUpdate("running", null))
          yield* saveCheckpoint("running", null)

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
              const latestStage =
                input.refreshStage === undefined
                  ? stage
                  : (yield* input.refreshStage(group.agentId, stage.id)) ?? stage
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
                  if (event._tag === "Started") resumeId = event.sessionId
                  if (event._tag === "Assistant") {
                    yield* Ref.update(assistant, (chunks) => [...chunks, event.text])
                  }
                  if (event._tag === "Failed") yield* Ref.set(emittedFailure, event.message)
                  yield* input.callbacks?.onEvent?.(group.agentId, stage.id, event) ?? Effect.void
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
                (yield* Ref.get(assistant)).join(""),
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
              yield* Ref.update(cachedWorkers, (workers) =>
                new Map(workers).set(ownerId, {
                  input,
                  group,
                  completedStageIds: new Set(completed),
                  resumeId,
                  attempt
                })
              )
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

          yield* notifyWorker(input.callbacks, workerUpdate(outcome.status, message))
          yield* saveCheckpoint(outcome.status, message)
          machine.stop()
            return {
              agentId: group.agentId,
              ownerId,
              status: outcome.status,
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
      > =>
        Effect.gen(function* () {
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
            plans.has(input.planId)
              ? [false, plans]
              : [true, new Set(plans).add(input.planId)]
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
            for (const group of groups) {
              const ownerId = ownerIdFor(input.planId, group.agentId)
              const prior = checkpoints.get(group.agentId)
              yield* Ref.update(cancelled, (current) => {
                const next = new Set(current)
                next.delete(ownerId)
                return next
              })
              yield* Ref.update(cachedWorkers, (workers) =>
                new Map(workers).set(ownerId, {
                  input,
                  group,
                  completedStageIds: new Set(
                    prior?.completedStageIds ?? []
                  ),
                  resumeId: prior?.resumeId ?? null,
                  attempt: (prior?.attempt ?? 0) + 1
                })
              )
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
                next.delete(input.planId)
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
        const ownerId = ownerIdFor(request.planId, request.agentId)
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

      const isPlanRunning = (planId: string): Effect.Effect<boolean> =>
        Ref.get(activePlans).pipe(
          Effect.map((plans) => plans.has(planId))
        )

      const retryWorker = (request: {
        readonly planId: string
        readonly agentId: string
      }): Effect.Effect<OrchestrationWorkerResult, OrchestrationWorkerNotFoundError> =>
        Effect.gen(function* () {
          const ownerId = ownerIdFor(request.planId, request.agentId)
          const cached = (yield* Ref.get(cachedWorkers)).get(ownerId)
          if (cached === undefined) {
            return yield* new OrchestrationWorkerNotFoundError({
              message: `No worker "${request.agentId}" exists for plan "${request.planId}".`,
              planId: request.planId,
              agentId: request.agentId
            })
          }
          yield* Ref.update(cancelled, (current) => {
            const next = new Set(current)
            next.delete(ownerId)
            return next
          })
          return yield* runGroup(
            cached.input,
            cached.group,
            cached.completedStageIds,
            cached.resumeId,
            cached.attempt + 1
          )
        })

      return {
        execute,
        stopWorker,
        retryWorker,
        isPlanRunning
      }
    })
  }
) {}
