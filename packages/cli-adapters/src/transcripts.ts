import type { Message } from "@jingler/core"
import { Message as MessageSchema } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { open, stat } from "node:fs/promises"
import { AppPaths } from "./app-paths.js"

const MessageArray = Schema.Array(MessageSchema)
const PAGE_CURSOR = /^v1:(\d+)$/

interface TranscriptIndex {
  readonly version: 2
  readonly byteLength: number
  /** Atomic transcript replacements receive a new inode. */
  readonly inode: number
  readonly offsets: ReadonlyArray<readonly [start: number, end: number]>
}

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

      const indexFileFor = (chatId: string) =>
        fileFor(chatId).pipe(Effect.map((file) => `${file}.index`))

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
          const chunks = encoded.map((message) => JSON.stringify(message))
          const offsets: Array<readonly [number, number]> = []
          let byteOffset = 1
          for (const [index, chunk] of chunks.entries()) {
            const start = byteOffset
            const end = start + Buffer.byteLength(chunk)
            offsets.push([start, end])
            byteOffset = end + (index === chunks.length - 1 ? 0 : 1)
          }
          const serialized = `[${chunks.join(",")}]`
          // Write-then-rename, NOT a direct overwrite. `writeFileString` truncates
          // the target before writing, so killing the main process mid-write (an
          // electron-vite dev restart does exactly this, and we rewrite the whole
          // file on nearly every stream event) leaves a 0-byte transcript and the
          // session's entire history is gone. `rename` is atomic within a
          // filesystem: readers see either the old file or the new one, never a
          // half-written one.
          const tmp = `${file}.tmp`
          const indexFile = yield* indexFileFor(chatId)
          const indexTmp = `${indexFile}.tmp`
          const transcriptWritten = yield* fs
            .writeFileString(tmp, serialized)
            .pipe(
              Effect.andThen(fs.rename(tmp, file)),
              Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            )
          if (!transcriptWritten) return
          const inode = yield* Effect.tryPromise({
            try: async () => (await stat(file)).ino,
            catch: () => 0
          }).pipe(Effect.orElseSucceed(() => 0))
          const transcriptIndex: TranscriptIndex = {
            version: 2,
            byteLength: Buffer.byteLength(serialized),
            inode,
            offsets
          }
          // The index is disposable acceleration data. If its write is
          // interrupted, `listPage` validates it against the transcript length
          // and rebuilds it once from the authoritative JSON.
          yield* fs
            .writeFileString(indexTmp, JSON.stringify(transcriptIndex))
            .pipe(
              Effect.andThen(fs.rename(indexTmp, indexFile)),
              Effect.tapError(() => fs.remove(indexTmp).pipe(Effect.ignore)),
              Effect.ignore
            )
        })

      const list = (chatId: string) => readAll(chatId)

      const decodeIndex = (raw: string): TranscriptIndex | null => {
        try {
          const value: unknown = JSON.parse(raw)
          if (
            typeof value !== "object" ||
            value === null ||
            !("version" in value) ||
            value.version !== 2 ||
            !("byteLength" in value) ||
            typeof value.byteLength !== "number" ||
            !("inode" in value) ||
            typeof value.inode !== "number" ||
            !("offsets" in value) ||
            !Array.isArray(value.offsets)
          ) {
            return null
          }
          const offsets: Array<readonly [number, number]> = []
          for (const offset of value.offsets) {
            if (
              !Array.isArray(offset) ||
              offset.length !== 2 ||
              !offset.every(
                (entry) =>
                  typeof entry === "number" &&
                  Number.isSafeInteger(entry) &&
                  entry >= 0
              )
            ) {
              return null
            }
            offsets.push([offset[0]!, offset[1]!])
          }
          return {
            version: 2,
            byteLength: value.byteLength,
            inode: value.inode,
            offsets
          }
        } catch {
          return null
        }
      }

      const readIndex = (
        chatId: string
      ): Effect.Effect<TranscriptIndex | null, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(chatId)
          const indexFile = yield* indexFileFor(chatId)
          const raw = yield* fs
            .readFileString(indexFile)
            .pipe(Effect.orElseSucceed(() => ""))
          const decoded = decodeIndex(raw)
          if (decoded === null) return null
          const metadata = yield* Effect.tryPromise({
            try: async () => {
              const info = await stat(file)
              return { size: info.size, inode: info.ino }
            },
            catch: () => null
          }).pipe(Effect.orElseSucceed(() => null))
          return metadata?.size === decoded.byteLength &&
            metadata.inode === decoded.inode
            ? decoded
            : null
        })

      const ensureIndex = (
        chatId: string
      ): Effect.Effect<TranscriptIndex, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const existing = yield* readIndex(chatId)
          if (existing !== null) return existing
          const messages = yield* readAll(chatId)
          yield* writeAll(chatId, messages)
          return (
            (yield* readIndex(chatId)) ?? {
              version: 2,
              byteLength: 2,
              inode: 0,
              offsets: []
            }
          )
        })

      const readWindow = (
        file: string,
        start: number,
        end: number
      ): Effect.Effect<string, never> =>
        Effect.tryPromise({
          try: async () => {
            const handle = await open(file, "r")
            try {
              const buffer = Buffer.alloc(Math.max(0, end - start))
              await handle.read(buffer, 0, buffer.length, start)
              return buffer.toString("utf8")
            } finally {
              await handle.close()
            }
          },
          catch: () => undefined
        }).pipe(Effect.orElseSucceed(() => ""))

      /**
       * A window of the transcript, newest-anchored, for lazy back-loading.
       *
       * The renderer opens a session with only the tail in hand (a 46MB
       * transcript held whole as a parsed `Message[]` was hundreds of MB of
       * renderer heap per live session), then pages older turns in on demand.
       *
       * `before` is an opaque positional cursor returned by the previous page.
       * It never depends on message ids, so legacy duplicate ids remain fully
       * reachable. A validated offset sidecar lets each request read only its
       * byte window instead of reparsing the complete transcript.
       */
      const listPage = (
        chatId: string,
        options: { before?: string; limit: number }
      ): Effect.Effect<
        {
          messages: ReadonlyArray<Message>
          hasMore: boolean
          cursor?: string
        },
        never,
        TranscriptEnv
      > =>
        lock.withPermits(1)(Effect.gen(function* () {
          const index = yield* ensureIndex(chatId)
          const match =
            options.before === undefined
              ? null
              : PAGE_CURSOR.exec(options.before)
          if (options.before !== undefined && match === null) {
            return { messages: [], hasMore: false }
          }
          const requestedEnd =
            match === null ? index.offsets.length : Number(match[1])
          if (
            !Number.isSafeInteger(requestedEnd) ||
            requestedEnd < 0 ||
            requestedEnd > index.offsets.length
          ) {
            return { messages: [], hasMore: false }
          }
          const limit = Math.max(1, Math.min(500, Math.floor(options.limit)))
          const start = Math.max(0, requestedEnd - limit)
          if (start === requestedEnd) return { messages: [], hasMore: false }
          const first = index.offsets[start]
          const last = index.offsets[requestedEnd - 1]
          if (first === undefined || last === undefined) {
            return { messages: [], hasMore: false }
          }
          const file = yield* fileFor(chatId)
          const raw = yield* readWindow(file, first[0], last[1])
          const messages = yield* Schema.decodeUnknown(
            Schema.parseJson(MessageArray)
          )(`[${raw}]`).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Message>)
          )
          const hasMore = start > 0
          return {
            messages,
            hasMore,
            ...(hasMore ? { cursor: `v1:${start}` } : {})
          }
        }))

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
            const legacyIndex = yield* indexFileFor(sessionId)
            const chatIndex = yield* indexFileFor(chatId)
            const [legacyExists, chatExists] = yield* Effect.all([
              fs.exists(legacyFile).pipe(Effect.orElseSucceed(() => false)),
              fs.exists(chatFile).pipe(Effect.orElseSucceed(() => false))
            ])
            if (!legacyExists || chatExists) return
            yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
            yield* fs.rename(legacyFile, chatFile).pipe(Effect.ignore)
            if (yield* fs.exists(legacyIndex).pipe(Effect.orElseSucceed(() => false))) {
              yield* fs.rename(legacyIndex, chatIndex).pipe(Effect.ignore)
            }
          })
        )

      const remove = (chatId: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(chatId)
          yield* fs.remove(file).pipe(Effect.ignore)
          yield* fs.remove(yield* indexFileFor(chatId)).pipe(Effect.ignore)
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

      return { list, listPage, adoptLegacy, remove, append, patchLast, patchById }
    }
  }
) {}
