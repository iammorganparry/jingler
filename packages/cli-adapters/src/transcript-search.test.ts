import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message } from "@jingler/core"
import type { FileSystem, Path } from "@effect/platform"
import type { AppPaths } from "./app-paths.js"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TranscriptStore } from "./transcripts.js"
import { withTempRoot } from "./test-support.js"

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => { temp = withTempRoot() })
afterEach(() => temp.cleanup())
const message = (id: string, text: string): Message => ({ id, role: "assistant", parts: [{ _tag: "Text", text }], streaming: false, createdAt: "2026-11-05T00:00:00Z" })
const seed = (messages: ReadonlyArray<Message>) => {
  mkdirSync(join(temp.root, "transcripts"), { recursive: true })
  writeFileSync(join(temp.root, "transcripts/chat.json"), JSON.stringify(messages))
}
const run = <A>(effect: Effect.Effect<A, never, TranscriptStore | FileSystem.FileSystem | Path.Path | AppPaths>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(TranscriptStore.Default, temp.layer))))

describe("saved conversation search", () => {
  it("finds an old message and reopens its bounded page", async () => {
    seed(Array.from({ length: 450 }, (_, index) => message(`m${index}`, index === 12 ? "The buried Quartz capybara fix" : `Ordinary turn ${index}`)))
    const { hits, page } = await run(Effect.gen(function* () {
      const hits = yield* TranscriptStore.search("chat", " quartz   CAPYBARA ", 20)
      const page = yield* TranscriptStore.listPage("chat", { before: hits[0]!.before, limit: 200 })
      return { hits, page }
    }))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.messageId).toBe("m12")
    expect(page.messages[hits[0]!.messageIndex]?.id).toBe("m12")
    expect(page.messages.length).toBeLessThanOrEqual(200)
    expect(page.messages.some((entry) => entry.id === "m12")).toBe(true)
    expect(page.messages.some((entry) => entry.id === "m449")).toBe(false)
  })

  it("identifies the matching position when legacy message ids repeat", async () => {
    seed([message("duplicate", "An unrelated turn"), message("duplicate", "The actual needle")])
    const result = await run(Effect.gen(function* () {
      const hits = yield* TranscriptStore.search("chat", "needle", 20)
      const page = yield* TranscriptStore.listPage("chat", { before: hits[0]!.before, limit: 200 })
      return { hits, page }
    }))
    expect(result.hits).toHaveLength(1)
    expect(result.page.messages[result.hits[0]!.messageIndex]?.parts).toEqual([{ _tag: "Text", text: "The actual needle" }])
  })

  it("returns newest matches first, capped with snippets instead of full messages", async () => {
    seed(Array.from({ length: 30 }, (_, index) => message(`m${index}`, `${"prefix ".repeat(100)}needle ${index}${" suffix".repeat(100)}`)))
    const hits = await run(TranscriptStore.search("chat", "needle", 3))
    expect(hits.map((hit) => hit.messageId)).toEqual(["m29", "m28", "m27"])
    expect(hits.every((hit) => hit.snippet.includes("needle") && hit.snippet.length <= 222)).toBe(true)
    expect(hits[0]).not.toHaveProperty("parts")
  })

  it("does not return private thinking or short queries", async () => {
    seed([{ ...message("private", "Visible prose"), parts: [{ _tag: "Thinking", text: "secret needle", seconds: null, streaming: false }, { _tag: "Text", text: "Visible prose" }] }])
    expect(await run(TranscriptStore.search("chat", "secret needle", 20))).toEqual([])
    expect(await run(TranscriptStore.search("chat", "vi", 20))).toEqual([])
  })

  it("observes changed and removed messages rather than returning a stale index", async () => {
    seed([message("first", "first needle")])
    const result = await run(Effect.gen(function* () {
      const first = yield* TranscriptStore.search("chat", "needle", 20)
      yield* TranscriptStore.patchById("chat", "first", () => message("first", "replacement text"))
      const replaced = yield* TranscriptStore.search("chat", "needle", 20)
      yield* TranscriptStore.append("chat", message("second", "second needle"))
      const appended = yield* TranscriptStore.search("chat", "needle", 20)
      yield* TranscriptStore.remove("chat")
      const removed = yield* TranscriptStore.search("chat", "needle", 20)
      return { first, replaced, appended, removed }
    }))
    expect(result.first.map((hit) => hit.messageId)).toEqual(["first"])
    expect(result.replaced).toEqual([])
    expect(result.appended.map((hit) => hit.messageId)).toEqual(["second"])
    expect(result.removed).toEqual([])
  })
})
