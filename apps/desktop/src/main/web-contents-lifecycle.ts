import { Deferred, Effect, FiberId, Stream } from "effect";

/**
 * A per-page-load interruption latch for the renderer's long-lived
 * subscription streams (`Theme.watch`, `Plugins.watch`, `Github.events`, …).
 *
 * Those streams are scoped resources whose finalizers close real handles —
 * `fs.watch` watchers (one of them recursive over the repo in dev), PubSub
 * subscriptions, PTY consumers. Their only teardown trigger used to be the
 * RPC server's `disconnects` sweep, which is keyed by `WebContents.id` — and a
 * reload KEEPS the id, so the old page's teardown races the new page's
 * re-subscription on the same client id. Every race lost stranded a watcher
 * fiber for the life of the app; hours of Vite HMR full reloads compounded
 * that into gigabytes.
 *
 * The latch removes the race: `firePageGone()` runs synchronously in the
 * navigation event, before the new document can boot and subscribe, so a
 * stream wrapped with `interruptOnPageGone` is interrupted (finalizers and
 * all) strictly before the replacement subscription captures the NEXT latch.
 */
let currentLatch = Deferred.unsafeMake<void>(FiberId.none);

/**
 * Interrupt every stream bound to the current page, then arm a fresh latch
 * for the next one. Call on `destroyed`, `render-process-gone`, and
 * main-frame non-same-document `did-start-navigation` — the same events that
 * feed the RPC server's `disconnects` mailbox, which stays load-bearing for
 * unary handlers and agent-run reservations.
 */
export const firePageGone = (): void => {
  const previous = currentLatch;
  currentLatch = Deferred.unsafeMake<void>(FiberId.none);
  Deferred.unsafeDone(previous, Effect.void);
};

/**
 * Bind a subscription stream to the page that subscribed to it. The latch is
 * read at subscription time (`Stream.suspend`), not module load, so a stream
 * created by the reloaded page binds to the reloaded page's latch.
 */
export const interruptOnPageGone = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.suspend(() => Stream.interruptWhenDeferred(stream, currentLatch));
