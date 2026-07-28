import type {
  Plan,
  PlanAcceptanceStatus,
  PlanDocument,
  PlanDocumentAuthor,
  PlanDocumentStatus,
  PlanPrd,
  SessionPlanArtifact
} from "@jingler/core"
import {
  appendPlanAnnotationSource,
  planDocumentToPlan,
  PlanConflictError,
  PlanPersistenceError,
  PlanValidationError,
  SessionPlanArtifact as SessionPlanArtifactSchema,
  updatePlanCriterionSource
} from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { legacyPlanToMdx, parsePlanMdx } from "./plan-mdx.js"

type PlanStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

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
  const result = parsePlanMdx(parsed.source)
  if (!result.valid) return null
  return { ...parsed.envelope, source: parsed.source, projection: result.projection }
}

const validate = (
  source: string
): Effect.Effect<PlanPrd, PlanValidationError> => {
  const result = parsePlanMdx(source)
  return result.valid
    ? Effect.succeed(result.projection)
    : Effect.fail(
        new PlanValidationError({
          message: "The plan is not valid PRD MDX.",
          diagnostics: [...result.diagnostics]
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

      const dirFor = (worktreePath: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.plansDir, path.basename(worktreePath))
        })

      const currentFileFor = (
        worktreePath: string
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          return path.join(yield* dirFor(worktreePath), "current-plan.mdx")
        })

      const fileFor = (
        worktreePath: string,
        _plan?: Plan
      ): Effect.Effect<string, never, Path.Path | AppPaths> => currentFileFor(worktreePath)

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
              parsePlanMdx(legacyPlan.raw).valid
                ? legacyPlan.raw
                : legacyPlanToMdx(legacyPlan)
            const parsed = parsePlanMdx(source)
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

      const promoteDocument = (
        worktreePath: string,
        input: {
          readonly sessionId: string
          readonly producingChatId: string
          readonly id?: string
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
            const projection = yield* validate(input.source)
            const current = yield* readCanonical(worktreePath)
            return yield* atomicWrite(worktreePath, {
              id: input.id ?? current?.id ?? crypto.randomUUID(),
              sessionId: input.sessionId,
              producingChatId: input.producingChatId,
              revision: (current?.revision ?? 0) + 1,
              status: input.status ?? "proposed",
              source: input.source,
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
            const projection = yield* validate(input.source)
            return yield* atomicWrite(worktreePath, {
              ...current,
              revision: current.revision + 1,
              source: input.source,
              projection,
              status: input.status ?? current.status,
              updatedAt: new Date().toISOString(),
              updatedBy: input.author
            })
          })
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
          const source = updatePlanCriterionSource(
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
            author: input.author
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
          const source = appendPlanAnnotationSource(current.source, {
            id,
            stageId: input.stageId,
            body: input.body,
            author: input.author,
            createdAt: new Date().toISOString()
          })
          return yield* updateDocument(worktreePath, {
            planId: input.planId,
            baseRevision: input.baseRevision,
            source,
            author: input.author
          })
        })

      const promote = (
        sessionId: string,
        worktreePath: string,
        producingChatId: string,
        plan: Plan
      ): Effect.Effect<
        SessionPlanArtifact,
        PlanValidationError | PlanPersistenceError,
        PlanStoreEnv
      > =>
        promoteDocument(worktreePath, {
          sessionId,
          producingChatId,
          id: plan.id,
          source: parsePlanMdx(plan.raw).valid ? plan.raw : legacyPlanToMdx(plan),
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
          return yield* updateDocument(worktreePath, {
            planId: current.id,
            baseRevision: current.revision,
            source: current.source,
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

      const removeAll = (worktreePath: string): Effect.Effect<void, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* fs.remove(yield* dirFor(worktreePath), { recursive: true }).pipe(Effect.ignore)
        })

      return {
        write,
        list,
        dirFor,
        fileFor,
        currentFileFor,
        readDocument,
        promoteDocument,
        updateDocument,
        setCriterionStatus,
        addAnnotation,
        readArtifact,
        promote,
        rehomeArtifact,
        markInterrupted,
        removeAll
      }
    }
  }
) {}
