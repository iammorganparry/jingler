import type { Message } from "@jingler/core"
import { Message as MessageSchema } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

const MessageArray = Schema.Array(MessageSchema)

type TranscriptEnv = FileSystem.FileSystem | Path.Path | AppPaths

/**
 * Per-chat conversation transcript, persisted to
 * `~/jingler/transcripts/<chatId>.json`. Reads are best-effort (a missing or
 * malformed file yields an empty transcript so the session still opens), matching
 * `SessionStore`. `AgentRunner` writes here as it folds stream events, so
 * reopening a session shows its full history — the same `Message[]` the renderer
 * rendered live.
 */
export class TranscriptStore extends Effect.Service<TranscriptStore>()(
  "@jingler/TranscriptStore",
  {
    accessors: true,
    sync: () => {
      const lock = Effect.unsafeMakeSemaphore(1)
      const fileFor = (
        chatId: string
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.transcriptsDir, `${encodeURIComponent(chatId)}.json`)
        })

      const readAll = (
        chatId: string
      ): Effect.Effect<ReadonlyArray<Message>, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(chatId)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return []
          return yield* Schema.decodeUnknown(Schema.parseJson(MessageArray))(raw).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
        })

      const writeAll = (
        chatId: string,
        messages: ReadonlyArray<Message>
      ): Effect.Effect<void, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = yield* fileFor(chatId)
          yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
          const encoded = yield* Schema.encode(MessageArray)(messages).pipe(
            Effect.orElseSucceed(() => messages)
          )
          // Write-then-rename, NOT a direct overwrite. `writeFileString` truncates
          // the target before writing, so killing the main process mid-write (an
          // electron-vite dev restart does exactly this, and we rewrite the whole
          // file on nearly every stream event) leaves a 0-byte transcript and the
          // session's entire history is gone. `rename` is atomic within a
          // filesystem: readers see either the old file or the new one, never a
          // half-written one.
          const tmp = `${file}.tmp`
          yield* fs
            .writeFileString(tmp, JSON.stringify(encoded, null, 2))
            .pipe(
              Effect.andThen(fs.rename(tmp, file)),
              Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
              Effect.ignore
            )
        })

      const list = (chatId: string) => readAll(chatId)

      /**
       * Move a legacy session-keyed transcript into its synthesized first chat.
       * Rename makes adoption one-shot and atomic; if the chat already has a
       * transcript it always wins.
       */
      const adoptLegacy = (sessionId: string, chatId: string) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (sessionId === chatId) return
            const fs = yield* FileSystem.FileSystem
            const paths = yield* AppPaths
            const legacyFile = yield* fileFor(sessionId)
            const chatFile = yield* fileFor(chatId)
            const [legacyExists, chatExists] = yield* Effect.all([
              fs.exists(legacyFile).pipe(Effect.orElseSucceed(() => false)),
              fs.exists(chatFile).pipe(Effect.orElseSucceed(() => false))
            ])
            if (!legacyExists || chatExists) return
            yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
            yield* fs.rename(legacyFile, chatFile).pipe(Effect.ignore)
          })
        )

      const remove = (chatId: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(chatId)
          yield* fs.remove(file).pipe(Effect.ignore)
        })

      /** Append a message to the end of the transcript. */
      const append = (chatId: string, message: Message) =>
        Effect.gen(function* () {
          const existing = yield* readAll(chatId)
          yield* writeAll(chatId, [...existing, message])
        })

      /** Replace the last message via `fn` (a no-op when the transcript is empty). */
      const patchLast = (chatId: string, fn: (last: Message) => Message) =>
        Effect.gen(function* () {
          const existing = yield* readAll(chatId)
          if (existing.length === 0) return
          const next = [...existing.slice(0, -1), fn(existing[existing.length - 1]!)]
          yield* writeAll(chatId, next)
        })

      /**
       * Replace the message with `messageId` via `fn`. A no-op when no message
       * carries that id.
       *
       * `patchLast` can only reach the newest message, which is wrong for state
       * that lives further back — notably a plan part, which stays in the message
       * of the turn it was proposed in while execution continues across later
       * turns.
       */
      const patchById = (
        chatId: string,
        messageId: string,
        fn: (msg: Message) => Message
      ) =>
        Effect.gen(function* () {
          const existing = yield* readAll(chatId)
          const idx = existing.findIndex((m) => m.id === messageId)
          if (idx === -1) return
          const next = existing.map((m, i) => (i === idx ? fn(m) : m))
          yield* writeAll(chatId, next)
        })

      return { list, adoptLegacy, remove, append, patchLast, patchById }
    }
  }
) {}
