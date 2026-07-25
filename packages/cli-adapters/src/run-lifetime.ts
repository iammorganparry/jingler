/**
 * When a harness run is allowed to keep going, and why.
 *
 * Pulled out of `AgentRunner` as a pure decision because it is genuinely a policy
 * — three rules that interact — and it was previously spread across a fork, a
 * finalizer and a poll loop, where the only way to find out what the runner would
 * do was to run it. Here it is a table you can read, and a table the tests can
 * enumerate without an Effect runtime, a temp directory or a fake harness.
 *
 * The rules, in the order they matter:
 *
 *  1. **A turn nobody is watching ends.** A consumer that detaches before the
 *     terminal event has abandoned the turn — the window closed, the renderer
 *     crashed — and nobody asked for that work to continue. Left running it burns
 *     tokens invisibly.
 *  2. **Background work keeps the run alive.** Once the turn has settled, the
 *     process exists only to service tasks that outlive it: the harness has to
 *     still be consuming for a task's completion bookend to arrive at all. This is
 *     the rule the old scoped fork got wrong, which killed every backgrounded task
 *     at turn end while the dock went on reporting it as running.
 *  3. **A finished run ends.** Settled turn, no live tasks: nothing is left to
 *     wait for, and a harness kept past that is an orphaned process.
 */

/** What the runner knows about a run when it asks. */
export interface RunLifetimeState {
  /** Has the turn emitted its terminal event (`Done`/`Failed`)? */
  readonly turnSettled: boolean
  /** Is anything still reading this run's event stream? */
  readonly consumerAttached: boolean
  /** Unsettled background tasks belonging to this run's chat. */
  readonly liveBackgroundTasks: number
}

/**
 * The verdict, WITH its reason.
 *
 * The reason is not decoration: "why is this harness still alive?" is the question
 * anyone debugging a stuck chat or an orphaned process actually has, and deriving
 * it after the fact from three separate pieces of state is exactly what made the
 * original bug so hard to see. Carrying it means the answer can be asserted in a
 * test and logged at the point of decision.
 */
export type RunLifetime =
  | { readonly verdict: "run"; readonly because: "turn-in-flight" | "background-work" }
  | { readonly verdict: "end"; readonly because: "abandoned-mid-turn" | "work-finished" }

/** Decide a run's fate from what is currently true of it. */
export const runLifetime = (state: RunLifetimeState): RunLifetime => {
  // Rule 1. Checked first: an abandoned turn ends even if it managed to start a
  // background task on the way out, because the operator never saw either.
  if (!state.consumerAttached && !state.turnSettled) {
    return { verdict: "end", because: "abandoned-mid-turn" }
  }
  // The turn is still going and someone is watching it.
  if (!state.turnSettled) return { verdict: "run", because: "turn-in-flight" }
  // Rule 2.
  if (state.liveBackgroundTasks > 0) return { verdict: "run", because: "background-work" }
  // Rule 3.
  return { verdict: "end", because: "work-finished" }
}
