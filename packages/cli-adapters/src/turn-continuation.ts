/**
 * When a Claude turn's `result` is the END of the run, and when it is a SEAM in it.
 *
 * Pulled out of `claude-adapter` as a pure decision for the same reason
 * `run-lifetime.ts` was pulled out of `AgentRunner`: it is genuinely a policy —
 * three rules that interact — and it lived inline as one boolean expression at the
 * `result` plus a second, subtly different one at the foot of the message loop. The
 * only way to find out what the adapter would do was to run the whole SDK loop
 * against a mocked harness. Here it is a table you can read, and a table the tests
 * can enumerate without an Effect runtime, a fake SDK or a timer.
 *
 * The rules, in the order they matter:
 *
 *  1. **A failed turn always closes.** The run IS over. The input channel must be
 *     closed or the query would never end, and a withheld `Failed` would leave the
 *     turn streaming forever with nothing to settle it.
 *  2. **A pending steer outranks everything.** A message pushed in the last few
 *     milliseconds has not been read yet; closing the channel discards the
 *     operator's message outright. This is why `steered` is passed in rather than
 *     read here — `takeSteered()` is a CONSUMING read, and a `||` chain that
 *     short-circuited past it would strand the message it exists to notice.
 *  3. **Delegated work keeps the turn open.** The SDK backgrounds every `Task` by
 *     default, so the main agent's `result` routinely lands while its sub-agents
 *     are still working. Closing there ends the query, and since every sub-agent
 *     runs inside that one query with one `AbortController`, ending it kills all of
 *     them at once — which is exactly what "talking to the main agent killed my
 *     sub-agents" was.
 *  4. **Otherwise the turn is finished.** No steer, no sub-agents: nothing is left
 *     to wait for, and a query held past that never ends at all.
 */

/** What the run loop knows when it asks whether the turn may end. */
export interface TurnContinuationState {
  /**
   * Did a steer land in this turn?
   *
   * Pass the result of `live.takeSteered()`. It is a consuming read, so it must be
   * called exactly once per `result` and its value handed here — never re-read.
   */
  readonly steered: boolean
  /** Is a pushed message still sitting unread in the input channel? */
  readonly unread: boolean
  /** Sub-agents that have started and not yet emitted `SubagentEnded`. */
  readonly liveSubagents: number
  /** The terminal event this message carried, if any. */
  readonly terminalKind: "done" | "failed" | null
}

/**
 * The verdict, WITH its reason.
 *
 * The reason is not decoration. "Why is this turn still streaming?" is the question
 * anyone debugging a chat that will not settle actually has, and it also selects
 * the timer: a pending steer is answered in milliseconds, while a sub-agent runs
 * for minutes, so the two cannot share one grace period. Carrying the reason means
 * the caller picks the timer from the decision instead of re-deriving the state.
 */
export type TurnContinuation =
  | { readonly kind: "continue"; readonly because: "steer-pending" | "subagent-work" }
  | { readonly kind: "close"; readonly because: "turn-finished" | "failed" }

/** Decide whether this turn's input channel may close, from what is true of it. */
export const turnContinuation = (state: TurnContinuationState): TurnContinuation => {
  // Rule 1. Checked first: a failure closes even with sub-agents outstanding,
  // because the query carrying them has already gone wrong.
  if (state.terminalKind === "failed") return { kind: "close", because: "failed" }
  // Rule 2.
  if (state.steered || state.unread) return { kind: "continue", because: "steer-pending" }
  // Rule 3.
  if (state.liveSubagents > 0) return { kind: "continue", because: "subagent-work" }
  // Rule 4.
  return { kind: "close", because: "turn-finished" }
}
