import type { ExternalInstructionIdentity, Message, ProviderId } from "@jingler/core"
import { Message as MessageSchema } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { open, stat } from "node:fs/promises"
import { AppPaths } from "./app-paths.js"

const MessageArray = Schema.Array(MessageSchema)
const PAGE_CURSOR = /^v1:(\d+)$/
const CLOSE_BRACKET = Buffer.from("]")
let writeSequence = 0
const nextWriteId = (): number => ++writeSequence

/**
 * A page stops growing once it carries this many serialized bytes, whatever
 * the caller's message-count limit said. The count limit was calibrated for
 * chat-sized messages; agentic mega-turns reach 5MB apiece (one real session:
 * 18 messages, 7.3MB), and "200 messages" of those is not a page — it is the
 * whole file shipped through schema-encode, structured clone, and
 * schema-decode on the renderer's main thread. The newest message is always
 * included, however large: a page must never be empty, and its render cost is
 * bounded separately (mega-turns collapse to their tail in `message-turn`).
 */
const PAGE_BYTE_BUDGET = 1_500_000

interface TranscriptIndex {
  readonly version: 2
  readonly byteLength: number
  /** Atomic transcript replacements receive a new inode. */
  readonly inode: number
  readonly offsets: ReadonlyArray<readonly [start: number, end: number]>
}

/**
 * The structural invariants the byte-splicing paths rely on: offsets start at
 * byte 1, abut with exactly one separator byte between messages, and end flush
 * against the closing bracket (an empty transcript is exactly `[]`).
 */
const structurallySound = (index: TranscriptIndex): boolean => {
  let previousEnd = 0
  for (const [start, end] of index.offsets) {
    if (start !== previousEnd + 1 || end < start) return false
    previousEnd = end
  }
  return index.byteLength === (index.offsets.length === 0 ? 2 : previousEnd + 1)
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

      /**
       * Persist an already-serialized transcript (the exact `[…]` text) plus its
       * byte-offset index. Shared by `writeAll` (full re-encode) and the bounded
       * mutation paths below, which splice raw bytes and must produce byte-for-byte
       * the same file/index shape this writes.
       */
      const writeSerialized = (
        chatId: string,
        serialized: string,
        offsets: ReadonlyArray<readonly [number, number]>
      ): Effect.Effect<void, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const file = yield* fileFor(chatId)
          yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
          // Write-then-rename, NOT a direct overwrite. `writeFileString` truncates
          // the target before writing, so killing the main process mid-write (an
          // electron-vite dev restart does exactly this, and we rewrite the whole
          // file on nearly every stream event) leaves a 0-byte transcript and the
          // session's entire history is gone. `rename` is atomic within a
          // filesystem: readers see either the old file or the new one, never a
          // half-written one. Each write needs its own scratch path because
          // independent store instances can persist the same chat concurrently;
          // a shared `.tmp` lets the first rename consume the second writer's file.
          const writeId = nextWriteId()
          const tmp = `${file}.${process.pid}.${writeId}.tmp`
          const indexFile = yield* indexFileFor(chatId)
          const indexTmp = `${indexFile}.${process.pid}.${writeId}.tmp`
          const transcriptWritten = yield* fs
            .writeFileString(tmp, serialized)
            .pipe(
              Effect.andThen(fs.rename(tmp, file)),
              Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
              Effect.tapError((error) =>
                Effect.logError(
                  `Failed to persist transcript ${chatId}: ${String(error)}`
                )
              ),
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

      const writeAll = (
        chatId: string,
        messages: ReadonlyArray<Message>
      ): Effect.Effect<void, never, TranscriptEnv> =>
        Effect.gen(function* () {
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
          yield* writeSerialized(chatId, `[${chunks.join(",")}]`, offsets)
        })

      /** Schema-encode ONE message to the exact chunk text `writeAll` would emit. */
      const encodeOne = (message: Message): Effect.Effect<string> =>
        Schema.encode(MessageSchema)(message).pipe(
          Effect.orElseSucceed(() => message),
          Effect.map((encoded) => JSON.stringify(encoded))
        )

      /** Schema-decode one message slice; null (never a failure) when it doesn't parse. */
      const decodeSlice = (slice: string): Effect.Effect<Message | null> =>
        Schema.decodeUnknown(Schema.parseJson(MessageSchema))(slice).pipe(
          Effect.map((message): Message | null => message),
          Effect.orElseSucceed((): Message | null => null)
        )

      /**
       * The transcript's raw bytes together with a VALIDATED index, or null.
       *
       * This is the entry ticket to the bounded mutation paths: every write used
       * to be readAll → schema-decode of the ENTIRE message array → re-encode →
       * rewrite, which on a long session (a 58MB transcript was measured live)
       * costs seconds of main-process CPU and hundreds of MB of allocation per
       * turn boundary — the "session gets slower as it ages" failure. With a
       * trustworthy index the mutations below splice raw bytes instead and only
       * ever encode/decode the one message they touch.
       *
       * Trust is earned, not assumed: `readIndex` already checks size + inode
       * against the live file, and this re-checks the actual bytes read (the
       * stat and the read are two steps) plus the structural invariants the
       * splice math relies on — offsets that start at byte 1, abut with exactly
       * one separator byte, and end flush against the closing bracket. Anything
       * off → null, and the caller falls back to the readAll/writeAll path,
       * which rebuilds the index as it always has.
       */
      const readValidRaw = (
        chatId: string
      ): Effect.Effect<
        { readonly raw: Buffer; readonly index: TranscriptIndex } | null,
        never,
        TranscriptEnv
      > =>
        Effect.gen(function* () {
          const index = yield* readIndex(chatId)
          if (index === null) return null
          const fs = yield* FileSystem.FileSystem
          const file = yield* fileFor(chatId)
          const bytes = yield* fs
            .readFile(file)
            .pipe(Effect.orElseSucceed((): Uint8Array | null => null))
          if (bytes === null) return null
          const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          if (raw.byteLength !== index.byteLength) return null
          return structurallySound(index) ? { raw, index } : null
        })

      /**
       * Append already-decoded messages by splicing their encoded chunks onto the
       * raw tail. Caller holds the lock and has verified the index is non-empty.
       */
      const appendRaw = (
        chatId: string,
        state: { readonly raw: Buffer; readonly index: TranscriptIndex },
        toAppend: ReadonlyArray<Message>
      ): Effect.Effect<void, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const offsets = [...state.index.offsets]
          const lastEnd = offsets[offsets.length - 1]![1]
          const parts: Array<Buffer> = [state.raw.subarray(0, lastEnd)]
          let cursor = lastEnd
          for (const message of toAppend) {
            const chunk = Buffer.from(`,${yield* encodeOne(message)}`)
            parts.push(chunk)
            offsets.push([cursor + 1, cursor + chunk.byteLength])
            cursor += chunk.byteLength
          }
          parts.push(CLOSE_BRACKET)
          yield* writeSerialized(chatId, Buffer.concat(parts).toString("utf8"), offsets)
        })

      /**
       * Replace message `i` with an already-encoded chunk: copy the bytes either
       * side verbatim and shift every later offset by the size delta. For the
       * last message the suffix is just the closing bracket.
       */
      const writeSpliced = (
        chatId: string,
        state: { readonly raw: Buffer; readonly index: TranscriptIndex },
        i: number,
        chunk: Buffer
      ): Effect.Effect<void, never, TranscriptEnv> => {
        const [start, end] = state.index.offsets[i]!
        const delta = chunk.byteLength - (end - start)
        const serialized = Buffer.concat([
          state.raw.subarray(0, start),
          chunk,
          state.raw.subarray(end)
        ]).toString("utf8")
        const offsets = state.index.offsets.map(
          ([s, e], j): readonly [number, number] =>
            j < i ? [s, e] : j === i ? [start, start + chunk.byteLength] : [s + delta, e + delta]
        )
        return writeSerialized(chatId, serialized, offsets)
      }

      /**
       * `patchById`'s bounded path. The target is located by scanning raw slices
       * for the id's JSON encoding (`"id":"…"` — nested part ids can false-hit,
       * so each hit is verified by decoding just that slice). Returns true when
       * the outcome is settled — patched, or no slice carries the id — and false
       * when a candidate slice failed to decode and the caller must fall back.
       */
      const patchByIdRaw = (
        chatId: string,
        state: { readonly raw: Buffer; readonly index: TranscriptIndex },
        messageId: string,
        fn: (msg: Message) => Message
      ): Effect.Effect<boolean, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const needle = Buffer.from(`"id":${JSON.stringify(messageId)}`)
          for (let i = 0; i < state.index.offsets.length; i++) {
            const [start, end] = state.index.offsets[i]!
            const slice = state.raw.subarray(start, end)
            if (!slice.includes(needle)) continue
            const decoded = yield* decodeSlice(slice.toString("utf8"))
            if (decoded === null) return false
            if (decoded.id !== messageId) continue
            const chunk = Buffer.from(yield* encodeOne(fn(decoded)))
            yield* writeSpliced(chatId, state, i, chunk)
            return true
          }
          return true
        })

      /**
       * Whether any message carries this external-instruction identity, decided
       * from raw bytes: a message whose `deliveryId`/`semanticKey` EQUALS the
       * needle necessarily CONTAINS its JSON encoding (both sides are serialized
       * by the same JSON.stringify), so slices without either needle can't
       * match and are never parsed. Containment can false-positive (the value
       * quoted inside unrelated text), so hits are verified by decoding just
       * that slice. Returns null — "couldn't decide" — when a candidate slice
       * fails to decode; the caller then falls back to the readAll semantics.
       */
      const scanExternalInstruction = (
        state: { readonly raw: Buffer; readonly index: TranscriptIndex },
        identity: ExternalInstructionIdentity
      ): Effect.Effect<boolean | null> =>
        Effect.gen(function* () {
          const needles = [
            Buffer.from(JSON.stringify(identity.deliveryId)),
            Buffer.from(JSON.stringify(identity.semanticKey))
          ]
          if (!needles.some((needle) => state.raw.includes(needle))) return false
          const candidates = state.index.offsets.filter(([start, end]) => {
            const slice = state.raw.subarray(start, end)
            return needles.some((needle) => slice.includes(needle))
          })
          for (const [start, end] of candidates) {
            const decoded = yield* decodeSlice(
              state.raw.subarray(start, end).toString("utf8")
            )
            if (decoded === null) return null
            if (sameExternalInstruction(decoded, identity)) return true
          }
          return false
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
          // Walk back from the newest requested message until either the
          // count limit or the byte budget trips (see PAGE_BYTE_BUDGET).
          let start = requestedEnd
          let pageBytes = 0
          while (start > 0 && requestedEnd - start < limit) {
            const span = index.offsets[start - 1]
            if (span === undefined) break
            const size = span[1] - span[0]
            if (requestedEnd - start > 0 && pageBytes + size > PAGE_BYTE_BUDGET)
              break
            pageBytes += size
            start--
          }
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
        lock.withPermits(1)(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const file = yield* fileFor(chatId)
            yield* fs.remove(file).pipe(Effect.ignore)
            yield* fs.remove(yield* indexFileFor(chatId)).pipe(Effect.ignore)
          })
        )

      /**
       * Append a message to the end of the transcript. Bounded: with a valid
       * index only the NEW message is encoded — existing bytes are copied, never
       * schema-decoded. Falls back to the whole-file path (which rebuilds the
       * index) when the index is missing, stale, or the transcript is empty.
       */
      const append = (chatId: string, message: Message) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* readValidRaw(chatId)
            if (state !== null && state.index.offsets.length > 0) {
              return yield* appendRaw(chatId, state, [message])
            }
            const existing = yield* readAll(chatId)
            yield* writeAll(chatId, [...existing, message])
          })
        )

      const sameExternalInstruction = (
        message: Message,
        identity: ExternalInstructionIdentity
      ): boolean =>
        message.externalInstruction?.deliveryId === identity.deliveryId ||
        message.externalInstruction?.semanticKey === identity.semanticKey

      /**
       * `appendTurn`'s bounded path: replay-check from raw bytes, then splice
       * the pair onto the tail. Returns the appendTurn result, or null when a
       * candidate slice failed to decode and the caller must fall back.
       */
      const appendTurnRaw = (
        chatId: string,
        state: { readonly raw: Buffer; readonly index: TranscriptIndex },
        turn: readonly [user: Message, assistant: Message],
        identity: ExternalInstructionIdentity | undefined
      ): Effect.Effect<boolean | null, never, TranscriptEnv> =>
        Effect.gen(function* () {
          const replay =
            identity === undefined
              ? false
              : yield* scanExternalInstruction(state, identity)
          if (replay === null) return null
          if (replay) return false
          yield* appendRaw(chatId, state, turn)
          return true
        })

      /** Durable idempotency check used before reserving or scheduling a run. */
      const hasExternalInstruction = (
        chatId: string,
        identity: ExternalInstructionIdentity
      ) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* readValidRaw(chatId)
            if (state !== null) {
              const found = yield* scanExternalInstruction(state, identity)
              if (found !== null) return found
            }
            const messages = yield* readAll(chatId)
            return messages.some((message) => sameExternalInstruction(message, identity))
          })
        )

      /**
       * Atomically persist a complete visible turn. External identities are
       * checked in the same transcript lock/write that appends the pair.
       */
      const appendTurn = (
        chatId: string,
        user: Message,
        assistant: Message,
        identity?: ExternalInstructionIdentity
      ) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* readValidRaw(chatId)
            const fast =
              state !== null && state.index.offsets.length > 0
                ? yield* appendTurnRaw(chatId, state, [user, assistant], identity)
                : null
            // null: no usable index, or a candidate slice failed to decode —
            // the whole-file path owns undecodable-transcript semantics.
            if (fast !== null) return fast
            const existing = yield* readAll(chatId)
            if (
              identity !== undefined &&
              existing.some((message) => sameExternalInstruction(message, identity))
            ) {
              return false
            }
            yield* writeAll(chatId, [...existing, user, assistant])
            return true
          })
        )

      /** Stamp legacy assistant turns before switching away from their provider. */
      const stampProvider = (chatId: string, providerId: ProviderId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readAll(chatId)
            const changed = existing.some(
              (message) => message.role === "assistant" && message.providerId === undefined
            )
            if (!changed) return
            yield* writeAll(
              chatId,
              existing.map((message) =>
                message.role === "assistant" && message.providerId === undefined
                  ? { ...message, providerId }
                  : message
              )
            )
          })
        )

      /**
       * Replace the last message via `fn` (a no-op when the transcript is empty).
       * Bounded: only the last message is decoded and re-encoded; every earlier
       * message rides along as raw bytes.
       */
      const patchLast = (chatId: string, fn: (last: Message) => Message) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* readValidRaw(chatId)
            if (state !== null && state.index.offsets.length > 0) {
              const last = state.index.offsets.length - 1
              const [start, end] = state.index.offsets[last]!
              const decoded = yield* decodeSlice(
                state.raw.subarray(start, end).toString("utf8")
              )
              if (decoded !== null) {
                const chunk = Buffer.from(yield* encodeOne(fn(decoded)))
                return yield* writeSpliced(chatId, state, last, chunk)
              }
            }
            const existing = yield* readAll(chatId)
            if (existing.length === 0) return
            const next = [...existing.slice(0, -1), fn(existing[existing.length - 1]!)]
            yield* writeAll(chatId, next)
          })
        )

      /**
       * Replace the message with `messageId` via `fn`. A no-op when no message
       * carries that id.
       *
       * `patchLast` can only reach the newest message, which is wrong for state
       * that lives further back — notably a plan part, which stays in the message
       * of the turn it was proposed in while execution continues across later
       * turns.
       *
       * Bounded like `patchLast`: the target is located by scanning raw slices
       * for the id's JSON encoding (`"id":"…"` — nested part ids can false-hit,
       * so each hit is verified by decoding just that slice), then spliced in
       * place with the trailing offsets shifted by the size delta.
       */
      const patchById = (
        chatId: string,
        messageId: string,
        fn: (msg: Message) => Message
      ) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* readValidRaw(chatId)
            if (state !== null && state.index.offsets.length > 0) {
              const settled = yield* patchByIdRaw(chatId, state, messageId, fn)
              // Settled covers "patched" AND "no slice carries the id" — the
              // latter is a definitive no-op, same as `findIndex === -1` below.
              // Unsettled means a candidate slice failed to decode; the
              // whole-file path owns undecodable-transcript semantics.
              if (settled) return
            }
            const existing = yield* readAll(chatId)
            const idx = existing.findIndex((m) => m.id === messageId)
            if (idx === -1) return
            const next = existing.map((m, i) => (i === idx ? fn(m) : m))
            yield* writeAll(chatId, next)
          })
        )

      return {
        list,
        listPage,
        adoptLegacy,
        remove,
        append,
        appendTurn,
        hasExternalInstruction,
        stampProvider,
        patchLast,
        patchById
      }
    }
  }
) {}
