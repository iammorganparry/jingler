import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { anySessionRunActive, releaseSessionRun, reserveSessionRun } from "./run-coordinator.js"

/**
 * The session run coordinator gates concurrency PER OWNER, not per session:
 * distinct owners (a chat per chatId, `plan:<id>`, `planning`) run concurrently
 * against one session's shared worktree, but a single owner is single-flight — a
 * second run for an owner already live is refused. `anySessionRunActive` reflects
 * liveness so the learning daemon backs off while any run is in flight.
 *
 * The reservation map is module-level; every test releases what it reserves so
 * the tests stay independent and `anySessionRunActive` can be asserted false.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

describe("run-coordinator", () => {
  it("admits distinct owners in the same session concurrently", () => {
    // Two different chats (distinct owners) both run at once — the feature.
    expect(run(reserveSessionRun("admit", "chatA"))).toBe(true)
    expect(run(reserveSessionRun("admit", "chatB"))).toBe(true)
    run(releaseSessionRun("admit", "chatA"))
    run(releaseSessionRun("admit", "chatB"))
  })

  it("refuses a second run for the SAME owner, then re-admits after release", () => {
    // A racing double-send on one chat, or a double-click on approve for one
    // plan, must not start a second run over the same fiber slot / artifact.
    expect(run(reserveSessionRun("single", "chatA"))).toBe(true)
    expect(run(reserveSessionRun("single", "chatA"))).toBe(false)
    run(releaseSessionRun("single", "chatA"))
    // Once the first run ends, the same owner can start again.
    expect(run(reserveSessionRun("single", "chatA"))).toBe(true)
    run(releaseSessionRun("single", "chatA"))
    expect(run(anySessionRunActive)).toBe(false)
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
