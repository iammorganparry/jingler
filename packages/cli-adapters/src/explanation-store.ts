import { createHash, randomUUID } from "node:crypto"
import type { ExplanationDocument, ExplanationPayload } from "@jingler/core"
import { ExplanationDocument as ExplanationDocumentSchema } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Option, Schema, Stream } from "effect"
import { AppPaths } from "./app-paths.js"

export type ExplanationStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

const WATCH_DEBOUNCE_MS = 150
const WATCH_FALLBACK_POLL_INTERVAL = "2 seconds"
const encodeDocument = Schema.encodeSync(ExplanationDocumentSchema)
const decodeDocument = Schema.decodeUnknownEither(ExplanationDocumentSchema)

const asDocument = (raw: string): ExplanationDocument | null => {
  if (raw.trim().length === 0) return null
  try {
    const decoded = decodeDocument(JSON.parse(raw))
    return decoded._tag === "Right" ? decoded.right : null
  } catch {
    return null
  }
}

const emissionKey = (document: ExplanationDocument | null): string =>
  document === null ? "" : `${document.id}:${document.revision}`

/** Durable latest-value store for one visual explanation per worktree-backed session. */
export class ExplanationStore extends Effect.Service<ExplanationStore>()(
  "@jingler/ExplanationStore",
  {
    accessors: true,
    // biome-ignore lint/complexity/noExcessiveLinesPerFunction: one closure intentionally owns the shared atomic-write lock.
    sync: () => {
      const lock = Effect.unsafeMakeSemaphore(1)

      const dirFor = (worktreePath: string): Effect.Effect<string, never, ExplanationStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const paths = yield* AppPaths
          const canonical = yield* fs.realPath(worktreePath).pipe(
            Effect.orElseSucceed(() => path.resolve(worktreePath))
          )
          const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 12)
          return path.join(paths.plansDir, `${path.basename(canonical)}-${suffix}`)
        })

      const currentFileFor = (
        worktreePath: string
      ): Effect.Effect<string, never, ExplanationStoreEnv> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          return path.join(yield* dirFor(worktreePath), "current-explanation.json")
        })

      const readUnlocked = (
        worktreePath: string,
        sessionId?: string
      ): Effect.Effect<ExplanationDocument | null, never, ExplanationStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* currentFileFor(worktreePath)
          if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          const document = asDocument(raw)
          return document !== null && (sessionId === undefined || document.sessionId === sessionId)
            ? document
            : null
        })

      const read = (worktreePath: string, sessionId?: string) =>
        lock.withPermits(1)(readUnlocked(worktreePath, sessionId))

      const writeUnlocked = (
        worktreePath: string,
        document: ExplanationDocument
      ): Effect.Effect<ExplanationDocument, Error, ExplanationStoreEnv> =>
        Effect.gen(function* () {
          const decoded = decodeDocument(encodeDocument(document))
          if (decoded._tag === "Left") return yield* Effect.fail(new Error("Invalid explanation document"))
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* currentFileFor(worktreePath)
          const temp = `${file}.${document.revision}.tmp`
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs.writeFileString(temp, JSON.stringify(encodeDocument(decoded.right), null, 2))
          yield* fs.rename(temp, file).pipe(
            Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore))
          )
          return decoded.right
        }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))))

      const publish = (
        worktreePath: string,
        sessionId: string,
        producingChatId: string,
        explanation: ExplanationPayload
      ): Effect.Effect<ExplanationDocument, Error, ExplanationStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readUnlocked(worktreePath, sessionId)
            return yield* writeUnlocked(worktreePath, {
              id: current?.id ?? randomUUID(),
              sessionId,
              producingChatId,
              revision: (current?.revision ?? 0) + 1,
              ...explanation,
              updatedAt: new Date().toISOString()
            })
          })
        )

      const rehome = (
        worktreePath: string,
        sessionId: string,
        producingChatId: string
      ): Effect.Effect<ExplanationDocument | null, Error, ExplanationStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readUnlocked(worktreePath, sessionId)
            if (current === null || current.producingChatId === producingChatId) return current
            return yield* writeUnlocked(worktreePath, {
              ...current,
              producingChatId,
              revision: current.revision + 1,
              updatedAt: new Date().toISOString()
            })
          })
        )

      const readWatchEmission = (
        worktreePath: string,
        sessionId: string
      ): Effect.Effect<Option.Option<ExplanationDocument | null>, never, ExplanationStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const document = yield* read(worktreePath, sessionId)
          if (document !== null) return Option.some<ExplanationDocument | null>(document)
          const file = yield* currentFileFor(worktreePath)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true))
          return exists ? Option.none() : Option.some<ExplanationDocument | null>(null)
        })

      const watch = (
        worktreePath: string,
        sessionId: string
      ): Stream.Stream<ExplanationDocument | null, never, ExplanationStoreEnv> =>
        Stream.unwrap(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
          const baseline = yield* read(worktreePath, sessionId)
          const readEmission = readWatchEmission(worktreePath, sessionId)
          const polling = Stream.tick(WATCH_FALLBACK_POLL_INTERVAL).pipe(
            Stream.mapEffect(() => readEmission)
          )
          const changes = fs.watch(dir).pipe(
            Stream.debounce(WATCH_DEBOUNCE_MS),
            Stream.mapEffect(() => readEmission),
            Stream.catchAll(() => polling)
          )
          return Stream.make<[ExplanationDocument | null]>(baseline).pipe(
            Stream.concat(changes.pipe(Stream.merge(polling), Stream.filterMap((value) => value))),
            Stream.changesWith((left, right) => emissionKey(left) === emissionKey(right)),
            Stream.drop(1)
          )
        }))

      const removeAll = (worktreePath: string): Effect.Effect<void, never, ExplanationStoreEnv> =>
        lock.withPermits(1)(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* currentFileFor(worktreePath)
          yield* fs.remove(file).pipe(Effect.ignore)
        }))

      return { currentFileFor, read, publish, rehome, watch, removeAll }
    }
  }
) {}
