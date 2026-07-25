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
