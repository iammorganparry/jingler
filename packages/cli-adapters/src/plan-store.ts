import type {
  PlanAcceptanceStatus,
  PlanCommentMessageDeliveryState,
  PlanCommentMentionDelivery,
  PlanDocumentAuthor,
  PlanDocumentStatus,
  PlanPrd,
  PlanTaskStatus,
  SessionPlanArtifact
} from "@jingler/core"
import {
  defaultPlan,
  planDocumentToPlan,
  PlanConflictError,
  PlanDocument,
  PlanPersistenceError,
  planStageSemanticFingerprint,
  planStructuralDiagnostics,
  PlanValidationError,
  reconcilePlanAmendment
} from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { AppPaths } from "./app-paths.js"
import {
  appendAnnotation,
  appendCommentMessage,
  setAnnotationStatus,
  setCriterionStatus as setPlanCriterionStatus,
  setTaskStatus as setPlanTaskStatus,
  updateMentionDeliveries,
  updateMessageDelivery
} from "./plan-mutations.js"

export type PlanStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

/** Editors save a file two or three times within a few ms; collapse the burst. */
const WATCH_DEBOUNCE_MS = 150
const WATCH_FALLBACK_POLL_INTERVAL = "2 seconds"

/** Retained for callers that link to a plan file; all plans now use one name. */
export const planFileName = (_input: string): string => "current-plan"

const encodeDocument = Schema.encodeSync(PlanDocument)
const decodeDocument = Schema.decodeUnknownEither(PlanDocument)

const serialize = (document: PlanDocument): string =>
  JSON.stringify(encodeDocument(document), null, 2)

/** Decode the JSON plan document, or null on missing/garbage content. */
const asDocument = (raw: string): PlanDocument | null => {
  if (raw.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const decoded = decodeDocument(parsed)
  return decoded._tag === "Right" ? decoded.right : null
}

/**
 * Validate a plan on the write path. The RPC boundary schema-types the DTO, so
 * this guards the invariants schema decoding cannot express: structural
 * integrity (unique stage + acceptance ids, no dangling/self dependencies, no
 * cycles, repository-relative file paths). Downstream views and mutations key by
 * id, so a duplicate would silently collapse stages or misfile evidence —
 * rejecting it here keeps every persisted plan addressable.
 */
const validate = (
  plan: PlanPrd
): Effect.Effect<PlanPrd, PlanValidationError> => {
  const decoded = Schema.decodeUnknownEither(
    (PlanDocument.fields as { readonly plan: Schema.Schema<PlanPrd> }).plan
  )(plan)
  if (decoded._tag !== "Right") {
    return Effect.fail(
      new PlanValidationError({
        message: "The plan is not a valid structured plan.",
        diagnostics: [{ code: "invalid-plan", message: "The plan failed structural validation.", line: 0 }]
      })
    )
  }
  const structural = planStructuralDiagnostics(decoded.right)
  return structural.length === 0
    ? Effect.succeed(decoded.right)
    : Effect.fail(
        new PlanValidationError({
          message: "The plan is not structurally valid.",
          diagnostics: structural.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            line: 0
          }))
        })
      )
}

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
          return path.join(yield* dirFor(worktreePath), "current-plan.json")
        })

      const fileFor = (
        worktreePath: string
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
          // Encode/decode once at the boundary so the object returned to the
          // caller is exactly the current persisted model. In particular, the
          // schema consumes legacy worker fields during decode and omits them
          // during encode; returning the pre-encoded input would briefly expose
          // state that disappears on the next read.
          const encoded = encodeDocument(document)
          const decoded = decodeDocument(encoded)
          if (decoded._tag === "Left") {
            yield* Effect.logError(
              `Plan ${document.id} failed its schema round-trip before persistence: ${String(decoded.left)}`
            )
          }
          const normalized = decoded._tag === "Right" ? decoded.right : document
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* currentFileFor(worktreePath)
          const temp = `${file}.${normalized.revision}.tmp`
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs.writeFileString(temp, serialize(normalized))
          yield* fs.rename(temp, file).pipe(
            Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore))
          )
          return normalized
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

      const readDocument = (
        worktreePath: string,
        _sessionId?: string,
        _producingChatId?: string
      ): Effect.Effect<PlanDocument | null, never, PlanStoreEnv> =>
        lock.withPermits(1)(readCanonical(worktreePath))

      /**
       * Create a blank, user-authored draft plan so the operator can start
       * filling one in for the agent BEFORE any agent run has proposed one.
       * Idempotent: if a canonical plan already exists (agent-proposed or a
       * prior draft) it is returned untouched — this never clobbers real content.
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
            plan: defaultPlan(),
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
          readonly plan: PlanPrd
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
              !amending ? null : reconcilePlanAmendment(current.plan, input.plan)
            if (reconciled !== null && !reconciled.valid) {
              return yield* new PlanValidationError({
                message: "The amended plan could not be reconciled.",
                diagnostics: reconciled.diagnostics.map((diagnostic) => ({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  line: 0
                }))
              })
            }
            let plan =
              reconciled?.valid === true ? reconciled.plan : yield* validate(input.plan)
            // A brand-new plan replacing an unrelated prior one starts fresh:
            // clear execution state and pending evidence.
            if (current !== null && !amending) {
              plan = {
                ...plan,
                stages: plan.stages.map((stage) => ({
                  ...stage,
                  tasks: (stage.tasks ?? []).map((task) => ({ ...task, status: "pending" })),
                  acceptance: stage.acceptance.map((criterion) => ({
                    ...criterion,
                    status: "pending",
                    evidence: null
                  }))
                }))
              }
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
              plan,
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
          readonly plan: PlanPrd
          readonly author: PlanDocumentAuthor
          readonly status?: PlanDocumentStatus
          /** False for mechanical criterion/annotation/status mutations. */
          readonly semantic?: boolean
          /**
           * Force amendment reconciliation regardless of author. Set for an
           * agent-authored amendment (the selected agent re-issuing its plan mid
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
                ? reconcilePlanAmendment(current.plan, input.plan, {
                    preserveAnnotations: true
                  })
                : input.semantic !== false && input.author === "user"
                  ? reconcilePlanAmendment(current.plan, input.plan, {
                      preserveAnnotations: false
                    })
                  : null
            if (reconciled !== null && !reconciled.valid) {
              return yield* new PlanValidationError({
                message: "The amended plan could not be reconciled.",
                diagnostics: reconciled.diagnostics.map((diagnostic) => ({
                  code: diagnostic.code,
                  message: diagnostic.message,
                  line: 0
                }))
              })
            }
            const plan =
              reconciled?.valid === true ? reconciled.plan : yield* validate(input.plan)
            return yield* atomicWrite(worktreePath, {
              ...current,
              revision: current.revision + 1,
              plan,
              status: input.status ?? current.status,
              updatedAt: new Date().toISOString(),
              updatedBy: input.author
            })
          })
        )

      /**
       * Mechanical worker writes always rebase onto the latest canonical source
       * while holding the same per-store lock as semantic edits. This preserves
       * both sides when an agent revision and task evidence arrive
       * together instead of letting a stale base revision overwrite either one.
       */
      const updateMechanical = (
        worktreePath: string,
        planId: string,
        transform: (
          plan: PlanPrd,
          document: PlanDocument
        ) => {
          readonly plan: PlanPrd | null
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
            const change = transform(current.plan, current)
            if (change.plan === null) return current
            return yield* atomicWrite(worktreePath, {
              ...current,
              revision: current.revision + 1,
              plan: change.plan,
              status: change.status ?? current.status,
              updatedAt: new Date().toISOString(),
              updatedBy: "agent"
            })
          })
        )

      const setTaskStatusLatest = (
        worktreePath: string,
        input: {
          readonly planId: string
          readonly stageId: string
          readonly taskId: string
          readonly status: PlanTaskStatus
          readonly expectedStageFingerprint?: string
        }
      ): Effect.Effect<
        PlanDocument | null,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        updateMechanical(worktreePath, input.planId, (plan) => {
          const stage = plan.stages.find((candidate) => candidate.id === input.stageId)
          const task = (stage?.tasks ?? []).find(
            (candidate) => candidate.id === input.taskId
          )
          if (
            stage === undefined ||
            task === undefined ||
            (input.expectedStageFingerprint !== undefined &&
              planStageSemanticFingerprint(stage) !== input.expectedStageFingerprint)
          ) return { plan: null }
          // Progress is durable and monotonic. A resumed provider can replay old
          // output from before its checkpoint; that must never turn completed
          // work back into in-progress work and cause a duplicate execution.
          if (
            task.status === input.status ||
            (task.status === "completed" && input.status !== "completed")
          ) return { plan: null }
          const withTask = setPlanTaskStatus(
            plan,
            input.stageId,
            input.taskId,
            input.status
          )
          if (withTask === null) return { plan: null }
          return { plan: withTask }
        })

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
          const plan = setPlanCriterionStatus(
            current.plan,
            input.criterionId,
            input.status,
            input.evidence
          )
          if (plan === null) {
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
            plan,
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
          const createdAt = new Date().toISOString()
          const plan = appendAnnotation(current.plan, {
            id,
            stageId: input.stageId,
            body: input.body,
            author: input.author,
            createdAt,
            status: "open",
            messages: [
              {
                id: `message-${crypto.randomUUID()}`,
                body: input.body,
                authorKind: input.author,
                authorId: input.authorId ?? input.author,
                createdAt,
                mentionedParticipantIds: [...new Set(input.mentionedParticipantIds ?? [])],
                // No mentions ⇒ nothing to dispatch, so the message is "sent".
                deliveryState:
                  input.deliveryState ??
                  ((input.mentionedParticipantIds ?? []).length > 0 ? "pending" : "sent")
              }
            ],
            ...(input.anchor ? { anchor: input.anchor } : {})
          })
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            plan,
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
          const plan = appendCommentMessage(
            current.plan,
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
          if (plan === null) {
            return yield* annotationMutationError(
              input.annotationId,
              "was not found or could not accept the message"
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            plan,
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
          const plan = updateMessageDelivery(
            current.plan,
            input.annotationId,
            input.messageId,
            input.deliveryState
          )
          if (plan === null) {
            return yield* annotationMutationError(
              input.annotationId,
              `does not contain message "${input.messageId}"`
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            plan,
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
          const plan = updateMentionDeliveries(
            current.plan,
            input.annotationId,
            input.messageId,
            input.deliveries,
            input.deliveryState
          )
          if (plan === null) {
            return yield* annotationMutationError(
              input.annotationId,
              `does not contain message "${input.messageId}"`
            )
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            plan,
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
          const plan = setAnnotationStatus(
            current.plan,
            input.annotationId,
            input.resolved ? "resolved" : "open"
          )
          if (plan === null) {
            return yield* annotationMutationError(input.annotationId, "was not found")
          }
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            plan,
            author: input.author,
            semantic: false
          })
        })

      const promote = (
        sessionId: string,
        worktreePath: string,
        producingChatId: string,
        plan: PlanPrd,
        input: { readonly id?: string; readonly basePlanId?: string; readonly status?: PlanDocumentStatus } = {}
      ): Effect.Effect<
        SessionPlanArtifact,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        promoteDocument(worktreePath, {
          sessionId,
          producingChatId,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.basePlanId === undefined ? {} : { basePlanId: input.basePlanId }),
          plan,
          status: input.status ?? "proposed",
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
          return yield* updateDocument(worktreePath, {
            planId: current.id,
            baseRevision: current.revision,
            plan: current.plan,
            author: "agent",
            status: "stale"
          }).pipe(Effect.orElseSucceed(() => current))
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
                  document.revision !== baseline.revision
              ),
              Stream.changesWith(
                (previous, current) => previous.revision === current.revision
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
        list,
        dirFor,
        fileFor,
        currentFileFor,
        readDocument,
        watch,
        startDraft,
        promoteDocument,
        updateDocument,
        setTaskStatusLatest,
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
