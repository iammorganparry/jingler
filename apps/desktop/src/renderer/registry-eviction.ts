/**
 * The least-recently-used eviction shared by the module-level actor registries
 * that are keyed per session but NOT the conversation registry.
 *
 * `use-file-browser.ts` and `plan-document-registry.ts` each hoist one XState
 * actor per session out of React, so the loaded state and its live subscriptions
 * survive tab changes and pane remounts. What neither had was the other end: an
 * actor was only ever freed when its session was permanently DELETED, so every
 * session the operator ever touched kept its actor — and with it a full worktree
 * unified-diff string, an open file's payload, or a plan document plus a live
 * `Plan.watch` — resident for the rest of the app's life. `actor-eviction.ts`
 * already caps the conversation registry the same way; this is the same policy
 * for its two siblings, kept generic over the one thing that differs between
 * them: which residents are PINNED (unsafe to drop).
 *
 * The loop is deliberately identical in shape to `keysToEvict`: LRU-first, stops
 * the moment the residents would fit under the cap (so a burst of switching does
 * not clear the whole cache), and never kills a pinned actor even if that leaves
 * it over the cap — a memory cap is not worth losing an unsaved draft or blanking
 * a surface the operator is looking at.
 */

/** One resident actor, as much as the policy needs to know about it. */
export interface LruCandidate {
  /** The registry's own key — for both siblings, the session id. */
  readonly key: string
  /**
   * Whether dropping this actor would lose something the operator cannot get
   * back on demand: an unsaved/mid-save draft, or a surface still mounted. The
   * meaning of "pinned" is the registry's to decide; the policy only obeys it.
   */
  readonly pinned: boolean
}

/**
 * The keys to stop and forget, given the residents in least-recently-used-FIRST
 * order.
 *
 * Returns empty when already under the cap, and can return fewer than needed (or
 * none) when the residents over the cap are all pinned.
 */
export const lruKeysToEvict = (
  candidates: ReadonlyArray<LruCandidate>,
  options: {
    /** Never evict this key — it's the one just created or touched. */
    readonly keep: string
    readonly max: number
  }
): ReadonlyArray<string> => {
  const evicted: Array<string> = []
  let resident = candidates.length

  for (const candidate of candidates) {
    if (resident <= options.max) break
    if (candidate.key === options.keep) continue
    if (candidate.pinned) continue
    evicted.push(candidate.key)
    resident -= 1
  }

  return evicted
}
