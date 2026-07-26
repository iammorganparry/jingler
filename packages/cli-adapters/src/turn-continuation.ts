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
 *  2. **Delegated work keeps the turn open, and outranks a steer.** The SDK
 *     backgrounds every `Task` by default, so the main agent's `result` routinely
 *     lands while its sub-agents are still working. Closing there ends the query,
 *     and since every sub-agent runs inside that one query with one
 *     `AbortController`, ending it kills all of them at once — which is exactly
 *     what "talking to the main agent killed my sub-agents" was.
 *
 *     It is checked BEFORE the steer because the reason doubles as the caller's
 *     timer, and when both are true the LONGER wait has to win. Reporting
 *     `steer-pending` here would arm a 2.5-second grace over live sub-agents, so a
 *     continuation that took three seconds to start would close the channel and
 *     kill them — trading the bug this module exists to fix for a turn that reads
 *     as settled a few seconds sooner.
 *  3. **A pending steer keeps it open too.** A message pushed in the last few
 *     milliseconds has not been read yet; closing the channel discards the
 *     operator's message outright. This is why `steered` is passed in rather than
 *     read here — `takeSteered()` is a CONSUMING read, and a `||` chain that
 *     short-circuited past it would strand the message it exists to notice.
 *
 *     Callers must also REMEMBER this across messages. The SDK pulls a pushed
 *     message out of the channel within a microtask, so a later `unread` check
 *     reports false whether or not the CLI has acted on it: asking again from
 *     scratch says "nothing pending" and closes the turn the push just opened.
 *  4. **Otherwise the turn is finished.** No steer, no sub-agents: nothing is left
 *     to wait for, and a query held past that never ends at all.
 */

/** What the run loop knows when it asks whether the turn may end. */
export interface TurnContinuationState {
  /**
   * Did a steer land in this turn?
   *
   * Pass the result of `live.takeSteered()`, OR'd with whatever the caller has
   * remembered from an earlier message — the read is consuming AND the SDK empties
   * the channel within a microtask, so this is not re-derivable later.
   */
  readonly steered: boolean
  /** Is a pushed message still sitting unread in the input channel? */
  readonly unread: boolean
  /** Sub-agents that have started and not yet emitted `SubagentEnded`. */
  readonly liveSubagents: number
  /**
   * The terminal event this message carried, if any.
   *
   * Only `"failed"` changes the verdict. `"done"` and `null` are DELIBERATELY
   * indistinguishable here — a `Done` is exactly what rules 2 and 3 exist to
   * withhold, so "the turn said it was finished" carries no weight the other
   * inputs don't already carry. It stays three-valued rather than collapsing to
   * a `failed` boolean because the caller reads the kind off the mapped events
   * either way, and a boolean at this seam would invite re-deriving "was this a
   * result?" from something else. Don't go hunting for a done/null branch: there
   * isn't one, and the exhaustive table asserts there never will be.
   */
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
  // Rule 2. Before the steer — see the header: both are `continue`, so the order
  // only picks the timer, and over live sub-agents the longer wait must win.
  if (state.liveSubagents > 0) return { kind: "continue", because: "subagent-work" }
  // Rule 3.
  if (state.steered || state.unread) return { kind: "continue", because: "steer-pending" }
  // Rule 4.
  return { kind: "close", because: "turn-finished" }
}
