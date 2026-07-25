/**
 * Collapse a burst of per-key updates into one trailing flush.
 *
 * Built for the conversation registry, whose actor subscription fires on EVERY
 * streamed token. Everything that subscription publishes — live activity, plan
 * presence, diff totals — is sidebar furniture read at human speed, but deriving
 * it per token meant re-walking the whole transcript and re-scanning the whole
 * worktree diff hundreds of times a second. On a long session that was where the
 * renderer's heap went.
 *
 * Trailing, and only ever ONE timer for the whole batch: the last value pushed
 * for a key inside the window is the one that gets flushed, and keys that saw a
 * thousand updates cost the same as keys that saw one.
 *
 * The important property is that coalescing cannot lose a SETTLED state — the
 * final value in a window is always delivered. It can only drop a state that
 * appeared and vanished again inside the window, which is a state no operator
 * could have acted on.
 */

export interface Coalescer<T> {
  /** Queue `value` under `key`, replacing anything already queued for it. */
  readonly push: (key: string, value: T) => void
  /** Drop anything queued under `key` (it was disposed before the flush landed). */
  readonly cancel: (key: string) => void
  /** Deliver everything queued right now, cancelling the pending timer. */
  readonly flushNow: () => void
}

/**
 * Make a coalescer that calls `flush` with the queued batch, at most once per
 * `delayMs`. The batch is handed over as a plain array of entries in the order the
 * keys were first queued, and the queue is cleared before `flush` runs — so a
 * `push` from inside `flush` correctly schedules the next window rather than being
 * swallowed by the one draining.
 */
export const createCoalescer = <T>(
  flush: (batch: ReadonlyArray<readonly [string, T]>) => void,
  delayMs: number
): Coalescer<T> => {
  const queued = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const drain = (): void => {
    timer = null
    if (queued.size === 0) return
    const batch = [...queued]
    queued.clear()
    flush(batch)
  }

  return {
    push: (key, value) => {
      queued.set(key, value)
      // Already scheduled: this update joins the window in flight rather than
      // pushing the deadline out. A steady stream of tokens must still flush at a
      // steady rate, which a debounce that resets on every push would never do.
      if (timer === null) timer = setTimeout(drain, delayMs)
    },
    cancel: (key) => {
      queued.delete(key)
    },
    flushNow: () => {
      if (timer !== null) clearTimeout(timer)
      drain()
    }
  }
}
