import { describe, expect, it } from "vitest"
import { runLifetime } from "./run-lifetime.js"
import type { RunLifetimeState } from "./run-lifetime.js"

/**
 * The whole decision table, enumerated. No runtime, no temp dir, no fake harness —
 * which is the point of having pulled it out: the rule that decides whether an
 * agent process lives or dies is the last thing that should only be observable by
 * running one.
 */

const state = (over: Partial<RunLifetimeState> = {}): RunLifetimeState => ({
  turnSettled: false,
  consumerAttached: true,
  liveBackgroundTasks: 0,
  ...over
})

describe("runLifetime", () => {
  it("keeps a turn that is still streaming to someone", () => {
    expect(runLifetime(state())).toEqual({ verdict: "run", because: "turn-in-flight" })
  })

  it("ends a turn abandoned before it settled", () => {
    // The window closed, or the renderer crashed. Nobody asked for this.
    expect(runLifetime(state({ consumerAttached: false }))).toEqual({
      verdict: "end",
      because: "abandoned-mid-turn"
    })
  })

  it("ends an abandoned turn even if it started background work on the way out", () => {
    // Deliberate: the operator never saw the turn OR the task it spawned, so there
    // is no expectation to honour — only a process to leak.
    expect(
      runLifetime(state({ consumerAttached: false, liveBackgroundTasks: 3 }))
    ).toEqual({ verdict: "end", because: "abandoned-mid-turn" })
  })

  it("keeps a settled turn alive while its background work runs", () => {
    // The rule the old scoped fork got wrong. The harness must still be consuming
    // for the task's completion bookend to arrive at all.
    expect(runLifetime(state({ turnSettled: true, liveBackgroundTasks: 1 }))).toEqual({
      verdict: "run",
      because: "background-work"
    })
  })

  it("keeps it alive whether or not anyone is still watching", () => {
    // Detaching AFTER the turn settled is the normal case — the renderer leaves
    // `running` on `Done`. That must not be what kills the task.
    expect(
      runLifetime(state({ turnSettled: true, consumerAttached: false, liveBackgroundTasks: 1 }))
    ).toEqual({ verdict: "run", because: "background-work" })
  })

  it("ends a settled turn with nothing left to do", () => {
    expect(runLifetime(state({ turnSettled: true }))).toEqual({
      verdict: "end",
      because: "work-finished"
    })
    expect(runLifetime(state({ turnSettled: true, consumerAttached: false }))).toEqual({
      verdict: "end",
      because: "work-finished"
    })
  })
})

/**
 * Why sub-agents are absent from this table, given they were being killed by it.
 *
 * `liveBackgroundTasks` counts the DOCK's tasks, and sub-agents are deliberately
 * filtered out of the dock (`claude-adapter.ts`, `isSubagentTask` — "the dock is
 * for work the operator has to mind"). So a settled turn with five live sub-agents
 * read as `work-finished` here, and `Fiber.interrupt` aborted the one SDK query all
 * five were running inside.
 *
 * The fix is upstream, in `turn-continuation.ts`: a turn with live sub-agents does
 * not emit its terminal event, so `turnSettled` stays FALSE and rule 1/2 keeps the
 * run alive without this policy knowing sub-agents exist. These cases pin the two
 * rows that fix depends on, so a later edit here cannot quietly reopen the bug.
 */
describe("runLifetime — the rows sub-agents depend on", () => {
  it("keeps an unsettled turn alive with no background tasks at all", () => {
    // THE ROW. A held-open turn looks exactly like this: watched, no terminal event
    // yet, nothing in the dock. If this ever returns `end`, every sub-agent dies
    // again and no test in `claude-adapter-subagents.test.ts` would notice.
    expect(runLifetime(state({ turnSettled: false, liveBackgroundTasks: 0 }))).toEqual({
      verdict: "run",
      because: "turn-in-flight"
    })
  })

  it("still ends an unsettled turn whose consumer detached — the known gap", () => {
    // Asserted so it is a decision, not an accident: closing the window (or an HMR
    // reload) mid-sub-agent DOES lose them, because rule 1 outranks everything and
    // a held `Done` widens the window in which that is true. Fixing it properly
    // means letting sub-agents outlive the turn, which is a separate change.
    expect(runLifetime(state({ turnSettled: false, consumerAttached: false }))).toEqual({
      verdict: "end",
      because: "abandoned-mid-turn"
    })
  })
})
