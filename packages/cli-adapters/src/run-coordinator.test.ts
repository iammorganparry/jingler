import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { anySessionRunActive, releaseSessionRun, reserveSessionRun } from "./run-coordinator.js"

/**
 * The session run coordinator no longer gates concurrency — multiple chats (and
 * plan/planning runs) may run against one session's shared worktree at once,
 * matching Conductor's shared-workspace model. These tests pin that a second
 * reservation is admitted, and that `anySessionRunActive` still reflects
 * liveness so the learning daemon backs off while any run is in flight.
 *
 * The reservation map is module-level; every test releases what it reserves so
 * the tests stay independent and `anySessionRunActive` can be asserted false.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

describe("run-coordinator", () => {
  it("admits a second concurrent owner in the same session", () => {
    expect(run(reserveSessionRun("admit", "chatA"))).toBe(true)
    // The old guard returned false here; concurrency means it is admitted.
    expect(run(reserveSessionRun("admit", "chatB"))).toBe(true)
    run(releaseSessionRun("admit", "chatA"))
    run(releaseSessionRun("admit", "chatB"))
  })

  it("stays active until the LAST owner releases", () => {
    run(reserveSessionRun("last", "chatA"))
    run(reserveSessionRun("last", "chatB"))
    run(releaseSessionRun("last", "chatA"))
    // chatB still running — the session is still active.
    expect(run(anySessionRunActive)).toBe(true)
    run(releaseSessionRun("last", "chatB"))
    // Both drained — nothing is running now.
    expect(run(anySessionRunActive)).toBe(false)
  })

  it("releasing an unknown owner is a harmless no-op", () => {
    expect(() => run(releaseSessionRun("ghost", "nobody"))).not.toThrow()
    expect(run(anySessionRunActive)).toBe(false)
  })
})
