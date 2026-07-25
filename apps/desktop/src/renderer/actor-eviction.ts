/**
 * Which conversation actors the registry may drop, and in what order.
 *
 * `conversation-registry.ts` keeps one XState actor per `session:chat`, hoisted
 * out of React on purpose so a background session's agent keeps working while the
 * operator looks at another. What it had no answer for was the other end: an actor
 * was only ever freed when its session was DELETED or its chat CLOSED, so every
 * session the operator opened kept its whole parsed transcript and its full
 * unified-diff patch string resident for the rest of the app's life. Across 72
 * sessions and 200MB of transcripts that is a multi-gigabyte retention path, and a
 * renderer measured at a 4.9GB footprint was mostly this.
 *
 * The cap has to be careful, because the registry exists precisely to keep work
 * alive across unmounts. An actor is only evictable when dropping it loses nothing
 * the operator can't get back: the transcript is on disk and re-loads on the next
 * visit, but a live run, a queued turn or half-typed prompt text exists ONLY in the
 * actor. Hence the guards below rather than a plain LRU.
 */
import type { ActivityPhase } from "@starbase/core"

/**
 * How many actors stay resident.
 *
 * Six covers the deepest session grid (four panes) with room to flick back to a
 * couple of recent sessions without paying a transcript re-load, while bounding the
 * retained transcripts at something that fits in a few hundred megabytes rather
 * than growing without limit.
 */
export const MAX_LIVE_ACTORS = 6

/** Everything the policy needs to know about one resident actor. */
export interface ActorCandidate {
  /** The registry's own `sessionId:chatId` key. */
  readonly key: string
  readonly sessionId: string
  /** Where the machine is — anything but `idle` means a run is in flight. */
  readonly phase: ActivityPhase
  /** Turns the operator queued behind the current one. Held nowhere else. */
  readonly queuedCount: number
  /** Prompt text mid-flight for this turn. Also held nowhere else. */
  readonly pendingText: string
}

/**
 * Whether this actor can be stopped without losing anything unrecoverable.
 *
 * Exported for the sake of being able to state each rule once and test it; the
 * registry only calls `keysToEvict`.
 */
export const isEvictable = (
  candidate: ActorCandidate,
  isVisible: (sessionId: string) => boolean
): boolean => {
  // A running or settling turn dies with its actor: stopping it tears down the
  // invoked `agentStream`, whose cleanup interrupts the RPC stream and kills the
  // run in main. This is the rule the whole registry exists to uphold.
  if (candidate.phase !== "idle") return false
  // Queued turns and pending prompt text live in machine context and nowhere else
  // — no transcript on disk to restore them from.
  if (candidate.queuedCount > 0) return false
  if (candidate.pendingText.trim() !== "") return false
  // On screen right now, possibly in another grid pane. Evicting would blank a
  // transcript the operator is looking at and immediately re-load it.
  if (isVisible(candidate.sessionId)) return false
  return true
}

/**
 * The keys to stop and forget, given the currently resident actors in
 * least-recently-used-FIRST order.
 *
 * Evicts only as far as it has to: the moment the residents would fit under `max`
 * it stops, so a burst of session switching doesn't clear the whole cache. Returns
 * empty when already under the cap, and can return fewer than needed (or none)
 * when the residents over the cap are all busy — a cap is not worth killing a live
 * run for.
 */
export const keysToEvict = (
  candidates: ReadonlyArray<ActorCandidate>,
  options: {
    /** Never evict this key — it's the one that was just created or touched. */
    readonly keep: string
    readonly max?: number
    readonly isVisible: (sessionId: string) => boolean
  }
): ReadonlyArray<string> => {
  const max = options.max ?? MAX_LIVE_ACTORS
  const evicted: Array<string> = []
  let resident = candidates.length

  for (const candidate of candidates) {
    if (resident <= max) break
    if (candidate.key === options.keep) continue
    if (!isEvictable(candidate, options.isVisible)) continue
    evicted.push(candidate.key)
    resident -= 1
  }

  return evicted
}
