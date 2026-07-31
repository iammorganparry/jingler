import { Deferred, Effect, Option, Ref } from "effect"
import type { DurationInput } from "effect/Duration"
import type { Attachment } from "@jingler/core"
import type { SteerTurn } from "./adapter.js"

export const STEER_HANDLER_TIMEOUT = "10 seconds"
export const STEER_REPLY_FIRST_CHUNK_TIMEOUT = "15 seconds"
export const STEER_REPLY_IDLE_TIMEOUT = "750 millis"
export const STEER_REPLY_OVERALL_TIMEOUT = "60 seconds"

export interface SteeredReplyWaiter {
  readonly firstChunk: Deferred.Deferred<void>
  readonly chunks: Ref.Ref<ReadonlyArray<string>>
  readonly revision: Ref.Ref<number>
}

export type BoundedSteerResult =
  | "accepted"
  | "deferred"
  | "failed"
  | "timed-out"

export const invokeSteer = (
  handler: SteerTurn,
  text: string,
  images: ReadonlyArray<Attachment>,
  timeout: DurationInput = STEER_HANDLER_TIMEOUT
): Effect.Effect<BoundedSteerResult> =>
  Effect.tryPromise(() => handler(text, images)).pipe(
    Effect.timeoutOption(timeout),
    Effect.map((result) =>
      Option.match(result, {
        onNone: () => "timed-out" as const,
        onSome: (outcome) => outcome
      })
    ),
    Effect.orElseSucceed(() => "failed" as const)
  )

export const makeSteeredReplyWaiter: Effect.Effect<SteeredReplyWaiter> =
  Effect.gen(function* () {
    return {
      firstChunk: yield* Deferred.make<void>(),
      chunks: yield* Ref.make<ReadonlyArray<string>>([]),
      revision: yield* Ref.make(0)
    }
  })

export const appendSteeredReply = (
  waiter: SteeredReplyWaiter,
  chunk: string
): Effect.Effect<void> =>
  Effect.all([
    Ref.update(waiter.chunks, (chunks) => [...chunks, chunk]),
    Ref.update(waiter.revision, (revision) => revision + 1),
    Deferred.succeed(waiter.firstChunk, undefined)
  ], { discard: true })

/**
 * Collect one serialized steering response.
 *
 * Harness adapters expose acceptance and assistant deltas, but no correlated
 * completion event for a steer. A resettable idle window is therefore the only
 * provider-neutral response boundary: every new chunk restarts the window,
 * while the overall timeout still prevents a chatty or broken harness from
 * owning the route forever.
 */
export const collectSteeredReply = (
  waiter: SteeredReplyWaiter
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const observed = yield* Deferred.await(waiter.firstChunk).pipe(
      Effect.timeoutOption(STEER_REPLY_FIRST_CHUNK_TIMEOUT)
    )
    if (Option.isNone(observed)) return null

    const waitForIdle = Effect.gen(function* () {
      let revision = yield* Ref.get(waiter.revision)
      while (true) {
        yield* Effect.sleep(STEER_REPLY_IDLE_TIMEOUT)
        const next = yield* Ref.get(waiter.revision)
        if (next === revision) return
        revision = next
      }
    })
    yield* waitForIdle.pipe(
      Effect.timeoutOption(STEER_REPLY_OVERALL_TIMEOUT)
    )
    const reply = (yield* Ref.get(waiter.chunks)).join("").trim()
    return reply.length === 0 ? null : reply
  })
