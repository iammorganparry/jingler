import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import {
  appendSteeredReply,
  collectSteeredReply,
  invokeSteer,
  makeSteeredReplyWaiter
} from "./steered-reply.js"

describe("steered reply collection", () => {
  it("waits for a resettable idle window instead of truncating slow chunks", async () => {
    const reply = await Effect.runPromise(
      Effect.gen(function* () {
        const waiter = yield* makeSteeredReplyWaiter
        const collector = yield* collectSteeredReply(waiter).pipe(Effect.fork)
        // The previous fixed window returned no reply after two seconds.
        yield* Effect.sleep("2100 millis")
        yield* appendSteeredReply(waiter, "A complete ")
        yield* Effect.sleep("100 millis")
        yield* appendSteeredReply(waiter, "streamed reply.")
        return yield* Fiber.join(collector)
      })
    )

    expect(reply).toBe("A complete streamed reply.")
  })

  it("bounds a steering callback that never settles", async () => {
    const result = await Effect.runPromise(
      invokeSteer(
        () => new Promise(() => undefined),
        "comment",
        [],
        "10 millis"
      )
    )

    expect(result).toBe("timed-out")
  })
})
