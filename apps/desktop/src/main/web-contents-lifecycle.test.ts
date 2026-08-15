import { describe, expect, it } from "vitest";
import { Deferred, Effect, Stream } from "effect";
import { firePageGone, interruptOnPageGone } from "./web-contents-lifecycle.js";

describe("web-contents-lifecycle", () => {
  it("interrupts a bound stream's scope when the page goes away", async () => {
    const released = Deferred.unsafeMake<void>(Effect.runSync(Effect.fiberId));
    // An endless scoped stream standing in for a watch subscription: the
    // finalizer is the observable — exactly what fs.watch teardown looks like.
    const endless = Stream.acquireRelease(Effect.void, () =>
      Deferred.succeed(released, undefined),
    ).pipe(Stream.flatMap(() => Stream.never));

    const fiber = Effect.runFork(
      Stream.runDrain(interruptOnPageGone(endless)),
    );
    // Give the fork a beat to subscribe before firing the latch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    firePageGone();
    await Effect.runPromise(Deferred.await(released));
    await Effect.runPromise(fiber.await);
    expect(Effect.runSync(Deferred.isDone(released))).toBe(true);
  });

  it("arms a fresh latch, so the next page's stream survives an old page's teardown", async () => {
    firePageGone(); // the "old page" going away…
    const collected = await Effect.runPromise(
      // …must not interrupt a stream subscribed AFTER it (the reloaded page).
      Stream.runCollect(interruptOnPageGone(Stream.make(1, 2, 3))),
    );
    expect([...collected]).toEqual([1, 2, 3]);
  });

  it("only trips subscriptions made before the firing, not after", async () => {
    const first = Effect.runFork(
      Stream.runDrain(interruptOnPageGone(Stream.never)),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    firePageGone();
    await Effect.runPromise(first.await); // old page's stream ends
    const second = Effect.runFork(
      Stream.runDrain(interruptOnPageGone(Stream.never)),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The new page's stream is still running against the fresh latch.
    expect(second.unsafePoll()).toBeNull();
    firePageGone();
    await Effect.runPromise(second.await);
  });
});
