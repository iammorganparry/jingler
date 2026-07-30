import type { Message } from "@jingler/core"
import { assistantMessage, userMessage } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { TranscriptStore } from "./transcripts.js"
import { withTempRoot } from "./test-support.js"

/**
 * The transcript is what reopening a session shows, so the behaviour that
 * matters is: it starts empty, appended turns survive a fresh read, and
 * `patchLast` replaces the streaming turn in place. Real temp filesystem, real
 * round-trips.
 */

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A>(
  effect: Effect.Effect<A, never, TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths>
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(TranscriptStore.Default, temp.layer))))

describe("TranscriptStore", () => {
  it("returns an empty transcript for an unknown session", async () => {
    const messages = await run(TranscriptStore.list("nope"))
    expect(messages).toStrictEqual([])
  })

  it("persists appended turns across a fresh read", async () => {
    const user = userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("s1", user)
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toStrictEqual([user])
  })

  it("keeps sibling chat transcripts isolated", async () => {
    const first = userMessage("u1", "Implement parser", "2026-07-11T10:00:00.000Z")
    const second = userMessage("u2", "Review migrations", "2026-07-11T10:00:01.000Z")
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("c1", first)
        yield* TranscriptStore.append("c2", second)
        return yield* Effect.all([
          TranscriptStore.list("c1"),
          TranscriptStore.list("c2")
        ])
      })
    )

    expect(messages[0]).toStrictEqual([first])
    expect(messages[1]).toStrictEqual([second])
  })

  it("keeps untrusted transcript keys inside the transcript directory", async () => {
    const result = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const paths = yield* AppPaths
        yield* TranscriptStore.append(
          "../config",
          userMessage("u1", "contained", "2026-07-11T10:00:00.000Z")
        )
        return {
          escaped: yield* fs
            .exists(path.join(paths.root, "config.json"))
            .pipe(Effect.orElseSucceed(() => false)),
          entries: yield* fs
            .readDirectory(paths.transcriptsDir)
            .pipe(Effect.orElseSucceed(() => []))
        }
      })
    )

    expect(result.escaped).toBe(false)
    expect(result.entries.sort()).toStrictEqual([
      "..%2Fconfig.json",
      "..%2Fconfig.json.index"
    ])
  })

  it("adopts a legacy session transcript into the synthesized first chat once", async () => {
    const legacy = userMessage("u1", "Legacy turn", "2026-07-11T10:00:00.000Z")
    const result = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("s1", legacy)
        yield* TranscriptStore.adoptLegacy("s1", "c_s1_1")
        yield* TranscriptStore.adoptLegacy("s1", "c_s1_1")
        return {
          legacy: yield* TranscriptStore.list("s1"),
          adopted: yield* TranscriptStore.list("c_s1_1")
        }
      })
    )

    expect(result.legacy).toStrictEqual([])
    expect(result.adopted).toStrictEqual([legacy])
  })

  it("patchLast replaces the last (streaming) turn in place", async () => {
    const user = userMessage("u1", "hi", "2026-07-11T10:00:00.000Z")
    const assistant = assistantMessage("a1", "2026-07-11T10:00:01.000Z")
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.append("s1", user)
        yield* TranscriptStore.append("s1", assistant)
        yield* TranscriptStore.patchLast("s1", (m): Message => ({
          ...m,
          streaming: false,
          parts: [{ _tag: "Text", text: "done" }]
        }))
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]).toStrictEqual(user)
    expect(messages[1]!.streaming).toBe(false)
    expect(messages[1]!.parts).toStrictEqual([{ _tag: "Text", text: "done" }])
  })

  it("leaves no scratch file behind, so a killed write cannot truncate history", async () => {
    const user = userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")
    const { entries, raw } = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const paths = yield* AppPaths
        yield* TranscriptStore.append("s1", user)
        yield* TranscriptStore.append("s1", assistantMessage("a1", "2026-07-11T10:00:01.000Z"))
        return {
          entries: yield* fs.readDirectory(paths.transcriptsDir),
          raw: yield* fs.readFileString(path.join(paths.transcriptsDir, "s1.json"))
        }
      }).pipe(Effect.orDie)
    )
    // A leftover `.tmp` means the rename never happened — and a direct overwrite
    // is what leaves a 0-byte transcript when the dev app restarts mid-write.
    expect(entries.filter((e) => e.endsWith(".tmp"))).toStrictEqual([])
    expect(entries.sort()).toStrictEqual(["s1.json", "s1.json.index"])
    expect(raw.length).toBeGreaterThan(0)
  })

  it("never writes over the live transcript — only to a scratch file it renames", async () => {
    // THE regression, asserted on the write MECHANISM rather than by racing a
    // process kill. `writeFileString` truncates its target before writing, and
    // `AgentRunner` rewrites the whole file on nearly every stream event, so
    // killing the main process mid-write (an electron-vite dev restart does
    // exactly that) left a 0-byte transcript and lost the session's history.
    //
    // Racing an interrupt against the write does NOT reproduce it: the interrupt
    // lands either side of the write, never inside the kernel call, so such a
    // test passes against the truncating implementation too — it looks like
    // coverage while asserting nothing. What actually rules the bug out is that
    // the live file is never opened for writing at all; it only ever appears via
    // an atomic rename. That is what this asserts.
    const calls: string[] = []
    const recording = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        writeFileString: (p: string, data: string, opts?: FileSystem.WriteFileStringOptions) => {
          calls.push(`write ${p.split("/").pop()}`)
          return fs.writeFileString(p, data, opts)
        },
        rename: (from: string, to: string) => {
          calls.push(`rename ${from.split("/").pop()} -> ${to.split("/").pop()}`)
          return fs.rename(from, to)
        }
      }))
    ).pipe(Layer.provide(temp.layer))

    await Effect.runPromise(
      TranscriptStore.append("s1", userMessage("u1", "hello", "2026-07-11T10:00:00.000Z")).pipe(
        Effect.provide(
          Layer.mergeAll(TranscriptStore.Default, temp.layer, recording) as Layer.Layer<
            TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths
          >
        )
      )
    )

    expect(calls).toStrictEqual([
      "write s1.json.tmp",
      "rename s1.json.tmp -> s1.json",
      "write s1.json.index.tmp",
      "rename s1.json.index.tmp -> s1.json.index"
    ])
    // Stated as its own assertion because it is the whole invariant: the live
    // transcript is never the target of a truncating write.
    expect(calls).not.toContain("write s1.json")
  })

  it("reads a 0-byte transcript as empty instead of failing the session open", async () => {
    // The other half of the historical failure: once a transcript HAD been
    // zeroed, opening the session had to still work. Best-effort reads are why
    // the bug presented as a silently blank pane rather than an error — worth
    // pinning, since it's the behaviour that made the data loss invisible.
    const messages = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const paths = yield* AppPaths
        yield* fs.makeDirectory(paths.transcriptsDir, { recursive: true }).pipe(Effect.ignore)
        yield* fs.writeFileString(path.join(paths.transcriptsDir, "zeroed.json"), "").pipe(Effect.ignore)
        return yield* TranscriptStore.list("zeroed")
      })
    )

    expect(messages).toStrictEqual([])
  })

  it("patchLast on an empty transcript is a no-op", async () => {
    const messages = await run(
      Effect.gen(function* () {
        yield* TranscriptStore.patchLast("s1", (m) => m)
        return yield* TranscriptStore.list("s1")
      })
    )
    expect(messages).toStrictEqual([])
  })

  describe("listPage — the renderer's windowed read", () => {
    // Ten user turns, u0 (oldest) .. u9 (newest), so a window's contents pin
    // exactly which slice came back.
    const turns = Array.from({ length: 10 }, (_, i) =>
      userMessage(`u${i}`, `turn ${i}`, `2026-07-11T10:00:0${i}.000Z`)
    )
    const seed = (chatId: string) =>
      Effect.forEach(turns, (m) => TranscriptStore.append(chatId, m), { discard: true })

    it("returns the newest window and flags older turns when omitting `before`", async () => {
      const page = await run(
        Effect.gen(function* () {
          yield* seed("s1")
          return yield* TranscriptStore.listPage("s1", { limit: 3 })
        })
      )
      expect(page.messages.map((m) => m.id)).toStrictEqual(["u7", "u8", "u9"])
      expect(page.hasMore).toBe(true)
      expect(page.cursor).toBe("v1:7")
    })

    it("returns the whole transcript with hasMore false when it fits in one window", async () => {
      const page = await run(
        Effect.gen(function* () {
          yield* seed("s1")
          return yield* TranscriptStore.listPage("s1", { limit: 50 })
        })
      )
      expect(page.messages).toHaveLength(10)
      expect(page.hasMore).toBe(false)
    })

    it("pages the window immediately before an opaque cursor", async () => {
      const page = await run(
        Effect.gen(function* () {
          yield* seed("s1")
          const newest = yield* TranscriptStore.listPage("s1", { limit: 3 })
          return yield* TranscriptStore.listPage("s1", {
            before: newest.cursor,
            limit: 3
          })
        })
      )
      expect(page.messages.map((m) => m.id)).toStrictEqual(["u4", "u5", "u6"])
      expect(page.hasMore).toBe(true)
      expect(page.cursor).toBe("v1:4")
    })

    it("reaches the start and clears hasMore on the final page", async () => {
      const page = await run(
        Effect.gen(function* () {
          yield* seed("s1")
          return yield* TranscriptStore.listPage("s1", {
            before: "v1:2",
            limit: 5
          })
        })
      )
      expect(page.messages.map((m) => m.id)).toStrictEqual(["u0", "u1"])
      expect(page.hasMore).toBe(false)
    })

    it("yields an empty window for an invalid opaque cursor", async () => {
      const page = await run(
        Effect.gen(function* () {
          yield* seed("s1")
          return yield* TranscriptStore.listPage("s1", { before: "nope", limit: 3 })
        })
      )
      expect(page.messages).toStrictEqual([])
      expect(page.hasMore).toBe(false)
    })

    it("reaches every message when legacy ids are duplicated", async () => {
      const ids = await run(
        Effect.gen(function* () {
          const duplicateTurns = Array.from({ length: 8 }, (_, index) =>
            userMessage(
              index === 1 || index === 6 ? "duplicate" : `u${index}`,
              `turn ${index}`,
              `2026-07-11T10:00:0${index}.000Z`
            )
          )
          yield* Effect.forEach(
            duplicateTurns,
            (message) => TranscriptStore.append("duplicate-chat", message),
            { discard: true }
          )
          const newest = yield* TranscriptStore.listPage("duplicate-chat", {
            limit: 3
          })
          const middle = yield* TranscriptStore.listPage("duplicate-chat", {
            before: newest.cursor,
            limit: 3
          })
          const oldest = yield* TranscriptStore.listPage("duplicate-chat", {
            before: middle.cursor,
            limit: 3
          })
          return [...oldest.messages, ...middle.messages, ...newest.messages].map(
            (message) => message.parts[0]
          )
        })
      )
      expect(ids).toStrictEqual(
        Array.from({ length: 8 }, (_, index) => ({
          _tag: "Text",
          text: `turn ${index}`
        }))
      )
    })
  })
})
