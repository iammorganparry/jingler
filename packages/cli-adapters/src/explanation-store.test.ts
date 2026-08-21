import { FileSystem, Path } from "@effect/platform"
import type { ExplanationPayload } from "@jingler/core"
import { Chunk, Effect, Fiber, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ExplanationStore } from "./explanation-store.js"
import { withTempRoot } from "./test-support.js"

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => { temp = withTempRoot() })
afterEach(() => temp.cleanup())

const run = <A, E>(effect: Effect.Effect<A, E, ExplanationStore | FileSystem.FileSystem | Path.Path | AppPaths>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(ExplanationStore.Default, temp.layer))))

const payload = (title: string): ExplanationPayload => ({
  title,
  summary: `Summary for ${title}`,
  sections: [{
    id: "flow",
    title: "Flow",
    blocks: [{ kind: "code", id: "tree", language: "text", code: "user\n  agent\n    view" }]
  }]
})

const WT = "/tmp/jingler/worktrees/project/session"

describe("ExplanationStore", () => {
  it("creates revision one and survives a read", async () => {
    const created = await run(ExplanationStore.publish(WT, "session-1", "chat-1", payload("First")))
    const restored = await run(ExplanationStore.read(WT, "session-1"))
    expect(created).toMatchObject({ revision: 1, title: "First", producingChatId: "chat-1" })
    expect(restored).toEqual(created)
  })

  it("advances one stable document", async () => {
    const first = await run(ExplanationStore.publish(WT, "session-1", "chat-1", payload("First")))
    const second = await run(ExplanationStore.publish(WT, "session-1", "chat-1", payload("Second")))
    expect(second.id).toBe(first.id)
    expect(second.revision).toBe(2)
    expect(second.title).toBe("Second")
  })

  it("notifies watchers of a new revision", async () => {
    const watched = await run(Effect.gen(function* () {
      const store = yield* ExplanationStore
      const fiber = yield* Stream.runCollect(store.watch(WT, "session-1").pipe(Stream.take(1))).pipe(Effect.fork)
      yield* Effect.sleep("25 millis")
      yield* store.publish(WT, "session-1", "chat-1", payload("Watched"))
      return yield* Fiber.join(fiber)
    }))
    expect(Chunk.toReadonlyArray(watched)[0]).toMatchObject({ title: "Watched", revision: 1 })
  })

  it("isolates worktree namespaces and removes only the selected artifact", async () => {
    const other = "/tmp/another/project/session"
    await run(ExplanationStore.publish(WT, "session-1", "chat-1", payload("First")))
    await run(ExplanationStore.publish(other, "session-2", "chat-2", payload("Other")))
    expect(await run(ExplanationStore.read(WT, "session-2"))).toBeNull()
    await run(ExplanationStore.removeAll(WT))
    expect(await run(ExplanationStore.read(WT, "session-1"))).toBeNull()
    expect(await run(ExplanationStore.read(other, "session-2"))).toMatchObject({ title: "Other" })
  })
})
