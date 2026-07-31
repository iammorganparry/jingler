import type {
  Plan,
  PlanAcceptanceStatus,
  PlanCommentMessageDeliveryState,
  PlanCommentMentionDelivery,
  PlanDocument,
  PlanDocumentAuthor,
  PlanDocumentStatus,
  PlanPrd,
  PlanStageExecutionStatus,
  SessionPlanArtifact
} from "@jingler/core"
import {
  appendPlanAnnotationHtml,
  appendPlanCommentMessageHtml,
  DEFAULT_PLAN_TEMPLATE_HTML,
  planDocumentToPlan,
  PlanConflictError,
  PlanPersistenceError,
  planStageSemanticFingerprint,
  PlanValidationError,
  reconcilePlanAmendment,
  resolvePlanWorkerAnnotationHtml,
  SessionPlanArtifact as SessionPlanArtifactSchema,
  updatePlanCriterionHtml,
  updatePlanAnnotationStatusHtml,
  updatePlanCommentMessageDeliveryHtml,
  updatePlanCommentMentionDeliveriesHtml,
  updatePlanStageExecutionHtml,
  upsertPlanWorkerAnnotationHtml
} from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import type { OrchestrationCheckpoint } from "./orchestration-service.js"
import { AppPaths } from "./app-paths.js"
import { legacyPlanToHtml, parsePlanHtml } from "./plan-html.js"

type PlanStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

/** Editors save a file two or three times within a few ms; collapse the burst. */
const WATCH_DEBOUNCE_MS = 150
const WATCH_FALLBACK_POLL_INTERVAL = "2 seconds"

interface PlanEnvelope {
  readonly id: string
  readonly sessionId: string
  readonly producingChatId: string
  readonly revision: number
  readonly status: PlanDocumentStatus
  readonly updatedAt: string
  readonly updatedBy: PlanDocumentAuthor
}

/** Retained for callers that link to a plan file; all plans now use one name. */
export const planFileName = (_input: string): string => "current-plan"

const quoted = (value: string): string => JSON.stringify(value)
const serialize = (document: PlanDocument): string => `---
jinglerPlan: 1
id: ${quoted(document.id)}
sessionId: ${quoted(document.sessionId)}
producingChatId: ${quoted(document.producingChatId)}
revision: ${document.revision}
status: ${quoted(document.status)}
updatedAt: ${quoted(document.updatedAt)}
updatedBy: ${quoted(document.updatedBy)}
---
${document.source.trimStart()}`

const parseEnvelope = (
  raw: string
): { readonly envelope: PlanEnvelope; readonly source: string } | null => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (match === null) return null
  const values = new Map<string, unknown>()
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":")
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    try {
      values.set(key, JSON.parse(value))
    } catch {
      values.set(key, value)
    }
  }
  const id = values.get("id")
  const sessionId = values.get("sessionId")
  const producingChatId = values.get("producingChatId")
  const revision = values.get("revision")
  const status = values.get("status")
  const updatedAt = values.get("updatedAt")
  const updatedBy = values.get("updatedBy")
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof producingChatId !== "string" ||
    typeof revision !== "number" ||
    typeof status !== "string" ||
    typeof updatedAt !== "string" ||
    (updatedBy !== "agent" && updatedBy !== "user")
  ) {
    return null
  }
  return {
    envelope: {
      id,
      sessionId,
      producingChatId,
      revision,
      status: status as PlanDocumentStatus,
      updatedAt,
      updatedBy
    },
    source: match[2]!
  }
}

const asDocument = (raw: string): PlanDocument | null => {
  const parsed = parseEnvelope(raw)
  if (parsed === null) return null
  const result = parsePlanHtml(parsed.source)
  if (!result.valid) return null
  return { ...parsed.envelope, source: result.html, projection: result.projection }
}

/**
 * Validate + sanitize a plan on the write path. Returns the SANITIZED html (the
 * bytes to persist — never the raw input) alongside its projection.
 */
const validate = (
  source: string
): Effect.Effect<{ readonly projection: PlanPrd; readonly html: string }, PlanValidationError> => {
  const result = parsePlanHtml(source)
  return result.valid
    ? Effect.succeed({ projection: result.projection, html: result.html })
    : Effect.fail(
        new PlanValidationError({
          message: "The plan is not valid PRD HTML.",
          diagnostics: result.diagnostics.map((d) => ({ code: d.code, message: d.message, line: 0 }))
        })
      )
}

const statusFromPlan = (plan: Plan): PlanDocumentStatus =>
  plan.status === "approved"
    ? "approved"
    : plan.status === "revising"
      ? "revising"
      : plan.status === "rejected"
        ? "rejected"
        : plan.status === "stale"
          ? "stale"
          : "proposed"

export class PlanStore extends Effect.Service<PlanStore>()(
  "@jingler/PlanStore",
  {
    accessors: true,
    sync: () => {
      const lock = Effect.unsafeMakeSemaphore(1)

      const namespacedDirFor = (
        worktreePath: string
      ): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const paths = yield* AppPaths
          const canonical = yield* fs.realPath(worktreePath).pipe(
            Effect.orElseSucceed(() => path.resolve(worktreePath))
          )
          const suffix = createHash("sha256")
            .update(canonical)
            .digest("hex")
            .slice(0, 12)
          return path.join(
            paths.plansDir,
            `${path.basename(canonical)}-${suffix}`
          )
        })

      /**
       * Resolve a collision-proof plan directory and lazily adopt the legacy
       * basename-only directory. Two direct repositories named `widget` now
       * receive different hashes even though their display names match.
       */
      const dirFor = (
        worktreePath: string
      ): Effect.Effect<
        string,
        never,
        FileSystem.FileSystem | Path.Path | AppPaths
      > =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const paths = yield* AppPaths
          const destination = yield* namespacedDirFor(worktreePath)
          const legacy = path.join(
            paths.plansDir,
            path.basename(worktreePath)
          )
          const [destinationExists, legacyExists] = yield* Effect.all([
            fs.exists(destination).pipe(Effect.orElseSucceed(() => false)),
            fs.exists(legacy).pipe(Effect.orElseSucceed(() => false))
          ])
          if (!destinationExists && legacyExists) {
            yield* fs.rename(legacy, destination).pipe(Effect.ignore)
          }
          return destination
        })

      const currentFileFor = (
        worktreePath: string
      ): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          return path.join(yield* dirFor(worktreePath), "current-plan.html")
        })

      const checkpointFileFor = (
        worktreePath: string
      ): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          return path.join(
            yield* dirFor(worktreePath),
            "orchestration-checkpoints.json"
          )
        })

      const fileFor = (
        worktreePath: string,
        _plan?: Plan
      ): Effect.Effect<
        string,
        never,
        FileSystem.FileSystem | Path.Path | AppPaths
      > => currentFileFor(worktreePath)

      const atomicWrite = (
        worktreePath: string,
        document: PlanDocument
      ): Effect.Effect<PlanDocument, PlanPersistenceError, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* currentFileFor(worktreePath)
          const temp = `${file}.${document.revision}.tmp`
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs.writeFileString(temp, serialize(document))
          yield* fs.rename(temp, file).pipe(
            Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore))
          )
          return document
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError(`Failed to atomically persist ${worktreePath}: ${String(error)}`)
          ),
          Effect.mapError(
            (error) =>
              new PlanPersistenceError({
                message: `Could not persist the canonical plan for ${worktreePath}.`,
                cause: String(error)
              })
          )
        )

      const readCanonical = (
        worktreePath: string
      ): Effect.Effect<PlanDocument | null, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* currentFileFor(worktreePath)
          if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          const document = asDocument(raw)
          if (document === null && raw.trim().length > 0) {
            yield* Effect.logWarning(`Ignoring invalid canonical plan document ${file}`)
          }
          return document
        })

      const newestLegacySource = (
        worktreePath: string
      ): Effect.Effect<string | null, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return null
          const entries = yield* fs
            .readDirectory(dir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          const candidates = entries
            .filter((name) => name.endsWith(".md"))
            .sort()
            .reverse()
          for (const name of candidates) {
            const source = yield* fs
              .readFileString(path.join(dir, name))
              .pipe(Effect.orElseSucceed(() => ""))
            if (source.trim().length > 0) return source
          }
          return null
        })

      const readLegacyArtifact = (
        worktreePath: string
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const file = path.join(yield* dirFor(worktreePath), "current-plan.json")
          if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return null
          return yield* Schema.decodeUnknown(
            Schema.parseJson(SessionPlanArtifactSchema)
          )(raw).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(`Ignoring invalid legacy plan artifact ${file}: ${String(error)}`)
            ),
            Effect.orElseSucceed(() => null)
          )
        })

      const readDocument = (
        worktreePath: string,
        sessionId?: string,
        producingChatId?: string
      ): Effect.Effect<PlanDocument | null, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readCanonical(worktreePath)
            if (current !== null) return current
            if (sessionId === undefined || producingChatId === undefined) return null
            const artifact = yield* readLegacyArtifact(worktreePath)
            const legacy = artifact === null ? yield* newestLegacySource(worktreePath) : null
            if (artifact === null && legacy === null) return null
            const legacyPlan: Plan =
              artifact?.plan ?? {
                id: crypto.randomUUID(),
                summary: "Imported implementation plan",
                graph: null,
                steps: [],
                comments: [],
                status: "proposed",
                structured: false,
                raw: legacy ?? ""
              }
            const source =
              parsePlanHtml(legacyPlan.raw).valid
                ? legacyPlan.raw
                : legacyPlanToHtml(legacyPlan)
            const parsed = parsePlanHtml(source)
            if (!parsed.valid) {
              yield* Effect.logWarning(
                `Could not safely import the legacy plan for ${worktreePath}; leaving the artifact untouched.`
              )
              return null
            }
            const document: PlanDocument = {
              id: legacyPlan.id,
              sessionId: artifact?.sessionId ?? sessionId,
              producingChatId: artifact?.producingChatId ?? producingChatId,
              revision: Math.max(1, artifact?.revision ?? 1),
              status: statusFromPlan(legacyPlan),
              source,
              projection: parsed.projection,
              updatedAt: artifact?.updatedAt ?? new Date().toISOString(),
              updatedBy: "agent"
            }
            return yield* atomicWrite(worktreePath, document).pipe(
              Effect.catchAll((error) =>
                Effect.logError(error.message).pipe(Effect.as(document))
              )
            )
          })
        )

      /**
       * Create a blank, user-authored draft plan from the HTML template so
       * the operator can start filling in a plan for the agent BEFORE any agent
       * run has proposed one. Idempotent: if a canonical plan already exists
       * (agent-proposed or a prior draft) it is returned untouched — this never
       * clobbers real content.
       */
      const startDraft = (
        worktreePath: string,
        sessionId: string,
        producingChatId: string
      ): Effect.Effect<
        PlanDocument,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current !== null) return current
          return yield* promoteDocument(worktreePath, {
            sessionId,
            producingChatId,
            source: DEFAULT_PLAN_TEMPLATE_HTML,
            status: "draft",
            author: "user"
          })
        })

      const promoteDocument = (
        worktreePath: string,
        input: {
          readonly sessionId: string
          readonly producingChatId: string
          readonly id?: string
          /** Reconcile only when this exact canonical plan is being amended. */
          readonly basePlanId?: string
          readonly source: string
          readonly status?: PlanDocumentStatus
          readonly author?: PlanDocumentAuthor
        }
      ): Effect.Effect<
        PlanDocument,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readCanonical(worktreePath)
            const amending =
              current !== null &&
              input.basePlanId !== undefined &&
              current.id === input.basePlanId
            const reconciled =
              !amending
                ? null
                : reconcilePlanAmendment(current, input.source)
            if (reconciled !== null && !reconciled.valid) {
              return yield* new PlanValidationError({
                message: "The amended plan is not valid PRD HTML.",
                diagnostics: reconciled.diagnostics.map((diagnostic) => ({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  line: 0
                }))
              })
            }
            const parsed =
              reconciled?.valid === true
                ? {
                    projection: reconciled.projection,
                    html: reconciled.source
                  }
                : yield* validate(input.source)
            let projection = parsed.projection
            let html = parsed.html
            if (current !== null && !amending) {
              for (const stage of projection.stages) {
                html =
                  updatePlanStageExecutionHtml(html, stage.id, "queued") ??
                  html
                for (const criterion of stage.acceptance) {
                  html =
                    updatePlanCriterionHtml(
                      html,
                      criterion.id,
                      "pending",
                      null
                    ) ?? html
                }
              }
              const fresh = yield* validate(html)
              projection = fresh.projection
              html = fresh.html
            }
            return yield* atomicWrite(worktreePath, {
              id: amending
                ? current.id
                : input.id === undefined || input.id === current?.id
                  ? crypto.randomUUID()
                  : input.id,
              sessionId: input.sessionId,
              producingChatId: input.producingChatId,
              revision: amending ? current.revision + 1 : 1,
              status: input.status ?? "proposed",
              source: html,
              projection,
              updatedAt: new Date().toISOString(),
              updatedBy: input.author ?? "agent"
            })
          })
        )

      const updateDocument = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly source: string
          readonly author: PlanDocumentAuthor
          readonly status?: PlanDocumentStatus
          /** False for mechanical criterion/annotation/status mutations. */
          readonly semantic?: boolean
          /**
           * Force amendment reconciliation regardless of author. Set for an
           * agent-authored amendment (the orchestrator re-issuing its plan mid
           * execution): prior evidence, assignments, and execution state are
           * carried onto matching ids, changed/new stages are requeued, and the
           * agent's omitted operational notes are preserved.
           */
          readonly reconcile?: boolean
        }
      ): Effect.Effect<
        PlanDocument,
        PlanConflictError | PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readCanonical(worktreePath)
            if (
              current === null ||
              current.id !== input.planId ||
              current.revision !== input.baseRevision
            ) {
              return yield* new PlanConflictError({
                message: "The canonical plan changed while this draft was being edited.",
                latestRevision: current?.revision ?? 0,
                latest: current
              })
            }
            const reconciled =
              input.reconcile === true
                ? reconcilePlanAmendment(current, input.source, {
                    preserveAnnotations: true
                  })
                : input.semantic !== false && input.author === "user"
                  ? reconcilePlanAmendment(current, input.source, {
                      preserveAnnotations: false
                    })
                  : null
            if (reconciled !== null && !reconciled.valid) {
              return yield* new PlanValidationError({
                message: "The amended plan is not valid PRD HTML.",
                diagnostics: reconciled.diagnostics.map((diagnostic) => ({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  line: 0
                }))
              })
            }
            const parsed =
              reconciled?.valid === true
                ? {
                    projection: reconciled.projection,
                    html: reconciled.source
                  }
                : yield* validate(input.source)
            return yield* atomicWrite(worktreePath, {
              ...current,
              revision: current.revision + 1,
              source: parsed.html,
              projection: parsed.projection,
              status: input.status ?? current.status,
              updatedAt: new Date().toISOString(),
              updatedBy: input.author
            })
          })
        )

      /**
       * Mechanical worker writes always rebase onto the latest canonical source
       * while holding the same per-store lock as semantic edits. This preserves
       * both sides when an orchestrator revision and worker evidence arrive
       * together instead of letting a stale base revision overwrite either one.
       */
      const updateMechanical = (
        worktreePath: string,
        planId: string,
        transform: (
          source: string,
          document: PlanDocument
        ) => {
          readonly source: string | null
          readonly status?: PlanDocumentStatus
        }
      ): Effect.Effect<
        PlanDocument | null,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readCanonical(worktreePath)
            if (current === null || current.id !== planId) return current
            const change = transform(current.source, current)
            if (change.source === null) return current
            const parsed = yield* validate(change.source)
            return yield* atomicWrite(worktreePath, {
              ...current,
              revision: current.revision + 1,
              source: parsed.html,
              projection: parsed.projection,
              status: change.status ?? current.status,
              updatedAt: new Date().toISOString(),
              updatedBy: "agent"
            })
          })
        )

      const setStageExecutionStatus = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly stageId: string
          readonly agentId: string
          readonly status: PlanStageExecutionStatus
          readonly message?: string | null
          readonly expectedStageFingerprint?: string
        }
      ): Effect.Effect<
        PlanDocument | null,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        updateMechanical(worktreePath, input.planId, (source, document) => {
          const stage = document.projection.stages.find(
            (candidate) => candidate.id === input.stageId
          )
          if (
            stage === undefined ||
            (input.expectedStageFingerprint !== undefined &&
              planStageSemanticFingerprint(stage) !==
                input.expectedStageFingerprint)
          ) return { source: null }
          const withStatus = updatePlanStageExecutionHtml(
            source,
            input.stageId,
            input.status
          )
          if (withStatus === null) return { source: null }
          const noteId = `worker-${input.agentId}-${input.stageId}`
          const message = input.message?.trim() ?? ""
          if (message.length > 0) {
            return {
              source: upsertPlanWorkerAnnotationHtml(withStatus, {
                id: noteId,
                stageId: input.stageId,
                body: message,
                status: "open",
                createdAt: new Date().toISOString(),
                authorId: input.agentId
              })
            }
          }
          return {
            source:
              input.status === "completed"
                ? resolvePlanWorkerAnnotationHtml(withStatus, noteId)
                : withStatus
          }
        })

      const setCriterionStatusLatest = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly criterionId: string
          readonly status: PlanAcceptanceStatus
          readonly evidence: string | null
          readonly stageId?: string
          readonly expectedStageFingerprint?: string
        }
      ): Effect.Effect<
        PlanDocument | null,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        updateMechanical(worktreePath, input.planId, (source, document) => {
          const stage = document.projection.stages.find((candidate) =>
            input.stageId === undefined
              ? candidate.acceptance.some(
                  (criterion) => criterion.id === input.criterionId
                )
              : candidate.id === input.stageId
          )
          if (
            stage === undefined ||
            (input.expectedStageFingerprint !== undefined &&
              planStageSemanticFingerprint(stage) !==
                input.expectedStageFingerprint)
          ) return { source: null }
          return {
            source: updatePlanCriterionHtml(
              source,
              input.criterionId,
              input.status,
              input.evidence
            )
          }
        })

      const settleOrchestration = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly workersCompleted: boolean
        }
      ): Effect.Effect<
        PlanDocument | null,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        updateMechanical(worktreePath, input.planId, (source, document) => {
          if (
            document.status !== "executing" &&
            document.status !== "needs-verification"
          ) {
            return { source: null }
          }
          const criteriaComplete = document.projection.stages.every((stage) =>
            stage.acceptance.every(
              (criterion) =>
                criterion.status === "passed" || criterion.status === "waived"
            )
          )
          return {
            source,
            status:
              input.workersCompleted && criteriaComplete
                ? "done"
                : "needs-verification"
          }
        })

      const readOrchestrationCheckpoints = (
        worktreePath: string,
        planId: string
      ): Effect.Effect<ReadonlyArray<OrchestrationCheckpoint>, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const file = yield* checkpointFileFor(worktreePath)
            const raw = yield* fs
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => ""))
            if (raw.length === 0) return []
            const parsed = JSON.parse(raw) as {
              readonly planId?: unknown
              readonly workers?: unknown
            }
            if (parsed.planId !== planId || !Array.isArray(parsed.workers)) {
              return []
            }
            return parsed.workers.filter(
              (value): value is OrchestrationCheckpoint => {
                if (typeof value !== "object" || value === null) return false
                const checkpoint = value as Partial<OrchestrationCheckpoint>
                return (
                  typeof checkpoint.agentId === "string" &&
                  typeof checkpoint.state === "string" &&
                  Array.isArray(checkpoint.completedStageIds) &&
                  checkpoint.completedStageIds.every(
                    (stageId) => typeof stageId === "string"
                  ) &&
                  (checkpoint.resumeId === null ||
                    typeof checkpoint.resumeId === "string") &&
                  (checkpoint.message === null ||
                    typeof checkpoint.message === "string") &&
                  typeof checkpoint.attempt === "number"
                )
              }
            )
          }).pipe(Effect.catchAll(() => Effect.succeed([])))
        )

      const writeOrchestrationCheckpoint = (
        worktreePath: string,
        planId: string,
        checkpoint: OrchestrationCheckpoint
      ): Effect.Effect<void, PlanPersistenceError, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const dir = yield* dirFor(worktreePath)
            const file = yield* checkpointFileFor(worktreePath)
            yield* fs.makeDirectory(dir, { recursive: true })
            const raw = yield* fs
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => ""))
            let workers: ReadonlyArray<OrchestrationCheckpoint> = []
            if (raw.length > 0) {
              try {
                const parsed = JSON.parse(raw) as {
                  readonly planId?: unknown
                  readonly workers?: unknown
                }
                if (parsed.planId === planId && Array.isArray(parsed.workers)) {
                  workers =
                    parsed.workers as ReadonlyArray<OrchestrationCheckpoint>
                }
              } catch {
                workers = []
              }
            }
            const next = [
              ...workers.filter(
                (worker) => worker.agentId !== checkpoint.agentId
              ),
              checkpoint
            ]
            const temp = `${file}.tmp`
            yield* fs.writeFileString(
              temp,
              JSON.stringify({ planId, workers: next }, null, 2)
            )
            yield* fs.rename(temp, file)
          }).pipe(
            Effect.mapError(
              (cause) =>
                new PlanPersistenceError({
                  message: "Could not persist the orchestration checkpoint.",
                  cause
                })
            )
          )
        )

      const setCriterionStatus = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly criterionId: string
          readonly status: PlanAcceptanceStatus
          readonly evidence: string | null
          readonly author: PlanDocumentAuthor
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const source = updatePlanCriterionHtml(
            current.source,
            input.criterionId,
            input.status,
            input.evidence
          )
          if (source === null) {
            return yield* new PlanValidationError({
              message: `Acceptance "${input.criterionId}" was not found.`,
              diagnostics: [
                {
                  code: "invalid-component",
                  message: `Acceptance "${input.criterionId}" was not found.`,
                  line: 1
                }
              ]
            })
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author,
            semantic: false
          })
        })

      const addAnnotation = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly stageId: string | null
          readonly body: string
          readonly author: PlanDocumentAuthor
          readonly authorId?: string
          readonly mentionedParticipantIds?: ReadonlyArray<string>
          readonly deliveryState?: PlanCommentMessageDeliveryState
          readonly anchor?: {
            readonly quote: string
            readonly prefix: string
            readonly suffix: string
          }
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const id = `annotation-${crypto.randomUUID()}`
          const source = appendPlanAnnotationHtml(current.source, {
            id,
            stageId: input.stageId,
            body: input.body,
            author: input.author,
            authorId: input.authorId,
            mentionedParticipantIds: input.mentionedParticipantIds,
            deliveryState: input.deliveryState,
            createdAt: new Date().toISOString(),
            ...(input.anchor ? { anchor: input.anchor } : {})
          })
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author,
            semantic: false
          })
        })

      const annotationMutationError = (
        annotationId: string,
        detail: string
      ): PlanValidationError =>
        new PlanValidationError({
          message: `Plan annotation "${annotationId}" ${detail}.`,
          diagnostics: [
            {
              code: "invalid-component",
              message: `Plan annotation "${annotationId}" ${detail}.`,
              line: 1
            }
          ]
        })

      /** Compare-and-swap append of one ordered entry to an existing thread. */
      const appendAnnotationMessage = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly annotationId: string
          readonly body: string
          readonly authorKind: PlanDocumentAuthor
          readonly authorId: string
          readonly mentionedParticipantIds: ReadonlyArray<string>
          readonly deliveryState: PlanCommentMessageDeliveryState
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const source = appendPlanCommentMessageHtml(
            current.source,
            input.annotationId,
            {
              id: `message-${crypto.randomUUID()}`,
              body: input.body,
              authorKind: input.authorKind,
              authorId: input.authorId,
              createdAt: new Date().toISOString(),
              mentionedParticipantIds: [...new Set(input.mentionedParticipantIds)],
              deliveryState: input.deliveryState
            }
          )
          if (source === null) {
            return yield* annotationMutationError(
              input.annotationId,
              "was not found or could not accept the message"
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.authorKind,
            semantic: false
          })
        })

      /** Compare-and-swap delivery-state update for one message in a thread. */
      const updateAnnotationMessageDelivery = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly annotationId: string
          readonly messageId: string
          readonly deliveryState: PlanCommentMessageDeliveryState
          readonly author: PlanDocumentAuthor
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const source = updatePlanCommentMessageDeliveryHtml(
            current.source,
            input.annotationId,
            input.messageId,
            input.deliveryState
          )
          if (source === null) {
            return yield* annotationMutationError(
              input.annotationId,
              `does not contain message "${input.messageId}"`
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author,
            semantic: false
          })
        })

      const updateAnnotationMentionDeliveries = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly annotationId: string
          readonly messageId: string
          readonly deliveries: ReadonlyArray<PlanCommentMentionDelivery>
          readonly deliveryState: PlanCommentMessageDeliveryState
          readonly author: PlanDocumentAuthor
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const source = updatePlanCommentMentionDeliveriesHtml(
            current.source,
            input.annotationId,
            input.messageId,
            input.deliveries,
            input.deliveryState
          )
          if (source === null) {
            return yield* annotationMutationError(
              input.annotationId,
              `does not contain message "${input.messageId}"`
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author,
            semantic: false
          })
        })

      /** Compare-and-swap resolution or reopening of one durable thread. */
      const setAnnotationResolved = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly baseRevision: number
          readonly annotationId: string
          readonly resolved: boolean
          readonly author: PlanDocumentAuthor
        }
      ) =>
        Effect.gen(function* () {
          const current = yield* readCanonical(worktreePath)
          if (current === null) {
            return yield* new PlanConflictError({
              message: "The canonical plan no longer exists.",
              latestRevision: 0,
              latest: null
            })
          }
          const source = updatePlanAnnotationStatusHtml(
            current.source,
            input.annotationId,
            input.resolved ? "resolved" : "open"
          )
          if (source === null) {
            return yield* annotationMutationError(input.annotationId, "was not found")
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author,
            semantic: false
          })
        })

      const promote = (
        sessionId: string,
        worktreePath: string,
        producingChatId: string,
        plan: Plan,
        basePlanId?: string
      ): Effect.Effect<
        SessionPlanArtifact,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        promoteDocument(worktreePath, {
          sessionId,
          producingChatId,
          id: plan.id,
          ...(basePlanId === undefined ? {} : { basePlanId }),
          source: parsePlanHtml(plan.raw).valid ? plan.raw : legacyPlanToHtml(plan),
          status: statusFromPlan(plan),
          author: "agent"
        }).pipe(
          Effect.map((document) => ({
            sessionId: document.sessionId,
            producingChatId: document.producingChatId,
            revision: document.revision,
            plan: planDocumentToPlan(document),
            updatedAt: document.updatedAt
          }))
        )

      const readArtifact = (
        worktreePath: string
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        readCanonical(worktreePath).pipe(
          Effect.map((document) =>
            document === null
              ? null
              : {
                  sessionId: document.sessionId,
                  producingChatId: document.producingChatId,
                  revision: document.revision,
                  plan: planDocumentToPlan(document),
                  updatedAt: document.updatedAt
                }
          )
        )

      const rehomeArtifact = (
        worktreePath: string,
        sessionId: string,
        fromChatId: string,
        toChatId: string
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readCanonical(worktreePath)
            if (
              current === null ||
              current.sessionId !== sessionId ||
              current.producingChatId !== fromChatId
            ) return current === null ? null : {
              sessionId: current.sessionId,
              producingChatId: current.producingChatId,
              revision: current.revision,
              plan: planDocumentToPlan(current),
              updatedAt: current.updatedAt
            }
            const document = yield* atomicWrite(worktreePath, {
              ...current,
              producingChatId: toChatId,
              revision: current.revision + 1,
              updatedAt: new Date().toISOString(),
              updatedBy: "user"
            })
            return {
              sessionId: document.sessionId,
              producingChatId: document.producingChatId,
              revision: document.revision,
              plan: planDocumentToPlan(document),
              updatedAt: document.updatedAt
            }
          })
        ).pipe(
          Effect.catchAll((error) =>
            Effect.logError(
              `Could not rehome the canonical plan for ${worktreePath}: ${error.message}`
            ).pipe(Effect.as(null))
          )
        )

      /**
       * No planning or execution run survives a desktop process restart.
       * Preserve the exact document but expose a deliberate resume action for
       * every canonical revision that was parked in an in-flight state.
       */
      const markInterrupted = (
        worktreePath: string,
        sessionId: string,
        producingChatId: string,
        updatedBefore?: string
      ): Effect.Effect<PlanDocument | null, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const current = yield* readDocument(worktreePath, sessionId, producingChatId)
          if (
            current === null ||
            (updatedBefore !== undefined && current.updatedAt > updatedBefore) ||
            !["proposed", "revising", "approved", "executing"].includes(current.status)
          ) return current
          let source = current.source
          for (const stage of current.projection.stages) {
            if (stage.executionStatus !== "running") continue
            source =
              updatePlanStageExecutionHtml(source, stage.id, "interrupted") ??
              source
          }
          return yield* updateDocument(worktreePath, {
            planId: current.id,
            baseRevision: current.revision,
            source,
            author: "agent",
            status: "stale"
          }).pipe(Effect.orElseSucceed(() => current))
        })

      const write = (
        worktreePath: string,
        plan: Plan
      ): Effect.Effect<string, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const file = yield* currentFileFor(worktreePath)
          const existing = yield* readCanonical(worktreePath)
          if (existing === null) {
            yield* promote("unknown", worktreePath, "unknown", plan).pipe(
              Effect.catchAll((error) =>
                Effect.logError(
                  `Could not write the canonical plan for ${worktreePath}: ${error.message}`
                )
              )
            )
          }
          return file
        })

      const list = (
        worktreePath: string
      ): Effect.Effect<ReadonlyArray<string>, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* currentFileFor(worktreePath)
          return (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) ? [file] : []
        })

      /**
       * Live-watch the canonical plan file, emitting the freshly-read document
       * on every external write. Replaces the renderer's fixed-interval poll.
       *
       * Modelled on `ThemeService.watch` — watch the DIRECTORY (so the first
       * write, which creates `current-plan.html`, is seen without a restart),
       * debounce editors' multi-save bursts and re-read through the same lock as
       * `readDocument`. A low-frequency poll is merged in because some mounted
       * filesystems end their native watcher silently; compare-and-swap writes
       * must still reach a live `Plan.watch` subscriber. `null` reads (plan
       * deleted / mid-write garbage) are filtered.
       *
       * **Consume with `Stream.unwrap(Effect.map(PlanStore, (s) => s.watch(...)))`,
       * never the generated accessor** — an `Effect<Stream<…>>` type-checks where
       * a `Stream` is wanted and silently yields a stream-of-one-stream. Same
       * shape and reason as `Theme.watch` / `Review.watch`.
       */
      const watch = (
        worktreePath: string,
        sessionId?: string,
        producingChatId?: string
      ): Stream.Stream<PlanDocument, never, PlanStoreEnv> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const dir = yield* dirFor(worktreePath)
            yield* fs
              .makeDirectory(dir, { recursive: true })
              .pipe(Effect.orElseSucceed(() => undefined))
            const baseline = yield* readDocument(
              worktreePath,
              sessionId,
              producingChatId
            )
            const filesystemChanges = fs.watch(dir).pipe(
              Stream.debounce(WATCH_DEBOUNCE_MS),
              Stream.mapEffect(() =>
                readDocument(worktreePath, sessionId, producingChatId)
              )
            )
            const pollingChanges = Stream.tick(WATCH_FALLBACK_POLL_INTERVAL).pipe(
              Stream.mapEffect(() =>
                readDocument(worktreePath, sessionId, producingChatId)
              )
            )
            const changes = filesystemChanges.pipe(
              Stream.concat(pollingChanges),
              Stream.catchAll(() => pollingChanges)
            )
            return changes.pipe(
              Stream.filter((document): document is PlanDocument => document !== null),
              Stream.filter(
                (document) =>
                  baseline === null ||
                  document.revision !== baseline.revision ||
                  document.source !== baseline.source
              ),
              Stream.changesWith(
                (previous, current) =>
                  previous.revision === current.revision &&
                  previous.source === current.source
              )
            )
          })
        )

      const removeAll = (worktreePath: string): Effect.Effect<void, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          // Never adopt-and-delete a basename-only legacy directory here: for
          // same-named repositories that directory may belong to the other
          // session. Normal reads migrate it; deletion removes only the
          // collision-proof directory proven to belong to this checkout.
          yield* fs
            .remove(yield* namespacedDirFor(worktreePath), { recursive: true })
            .pipe(Effect.ignore)
        })

      return {
        write,
        list,
        dirFor,
        fileFor,
        currentFileFor,
        readDocument,
        watch,
        startDraft,
        promoteDocument,
        updateDocument,
        setStageExecutionStatus,
        setCriterionStatusLatest,
        settleOrchestration,
        readOrchestrationCheckpoints,
        writeOrchestrationCheckpoint,
        setCriterionStatus,
        addAnnotation,
        appendAnnotationMessage,
        updateAnnotationMessageDelivery,
        updateAnnotationMentionDeliveries,
        setAnnotationResolved,
        readArtifact,
        promote,
        rehomeArtifact,
        markInterrupted,
        removeAll
      }
    }
  }
) {}
