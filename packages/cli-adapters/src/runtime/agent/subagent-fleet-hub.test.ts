import type { SubagentFleetEvent } from "@jingler/core"
import { Chunk, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { publishChatFleetEvent, watchChatFleet } from "./subagent-fleet-hub.js"

const remove = (id: string): SubagentFleetEvent => ({
  _tag: "Remove",
  version: 2,
  eventId: `remove:${id}`,
  occurredAt: 1,
  registryRevision: 1,
  id
})

// Give the forked watcher a tick to register before publishing.
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

describe("chat fleet hub", () => {
  it("delivers only the watched chat's events, then unregisters on interrupt", async () => {
    const received = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(watchChatFleet("s1", "c1"), 2)))
      yield* settle
      publishChatFleetEvent("s1", "c2", remove("other-chat"))
      publishChatFleetEvent("s2", "c1", remove("other-session"))
      publishChatFleetEvent("s1", "c1", remove("a"))
      publishChatFleetEvent("s1", "c1", remove("b"))
      return Chunk.toReadonlyArray(yield* Fiber.join(fiber))
    }))
    expect(received.map((event) => event._tag === "Remove" && event.id)).toEqual(["a", "b"])

    // A finished watcher is gone: publishing with no listener is a no-op, not a throw.
    expect(() => publishChatFleetEvent("s1", "c1", remove("late"))).not.toThrow()
  })

  it("fans out to every watcher of the same chat", async () => {
    const [left, right] = await Effect.runPromise(Effect.gen(function* () {
      const a = yield* Effect.fork(Stream.runCollect(Stream.take(watchChatFleet("s1", "c1"), 1)))
      const b = yield* Effect.fork(Stream.runCollect(Stream.take(watchChatFleet("s1", "c1"), 1)))
      yield* settle
      publishChatFleetEvent("s1", "c1", remove("shared"))
      return [Chunk.size(yield* Fiber.join(a)), Chunk.size(yield* Fiber.join(b))]
    }))
    expect([left, right]).toEqual([1, 1])
  })
})
