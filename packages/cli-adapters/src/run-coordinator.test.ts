import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  anySessionRunActive,
  reclaimSessionRun,
  releaseSessionRun,
  reserveSessionRun
} from "./run-coordinator.js"

/**
 * One shared holder for the tests that only care about reserve/refuse/release.
 * The supersession tests below mint their own, because there identity IS the
 * subject.
 */
const h: Record<never, never> = {}

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
    expect(run(reserveSessionRun("admit", "chatA", h))).toBe(true)
    expect(run(reserveSessionRun("admit", "chatB", h))).toBe(true)
    run(releaseSessionRun("admit", "chatA", h))
    run(releaseSessionRun("admit", "chatB", h))
  })

  it("refuses a second run for the SAME owner, then re-admits after release", () => {
    // A racing double-send on one chat, or a double-click on approve for one
    // plan, must not start a second run over the same fiber slot / artifact.
    expect(run(reserveSessionRun("single", "chatA", h))).toBe(true)
    expect(run(reserveSessionRun("single", "chatA", h))).toBe(false)
    run(releaseSessionRun("single", "chatA", h))
    // Once the first run ends, the same owner can start again.
    expect(run(reserveSessionRun("single", "chatA", h))).toBe(true)
    run(releaseSessionRun("single", "chatA", h))
    expect(run(anySessionRunActive)).toBe(false)
  })

  it("stays active until the LAST owner releases", () => {
    run(reserveSessionRun("last", "chatA", h))
    run(reserveSessionRun("last", "chatB", h))
    run(releaseSessionRun("last", "chatA", h))
    // chatB still running — the session is still active.
    expect(run(anySessionRunActive)).toBe(true)
    run(releaseSessionRun("last", "chatB", h))
    // Both drained — nothing is running now.
    expect(run(anySessionRunActive)).toBe(false)
  })

  it("ignores a release from a holder that has been superseded", () => {
    // The late finalizer of a run that was reclaimed. `AgentRunner` takes the slot
    // from a run whose turn has settled but whose harness lives on servicing a
    // background task; that run still unwinds later and still calls release. If it
    // freed the slot, the chat would silently lose single-flight — the next prompt
    // admitted alongside a live turn, both racing one transcript.
    const first = {}
    const second = {}
    expect(run(reserveSessionRun("supersede", "chatA", first))).toBe(true)
    run(reclaimSessionRun("supersede", "chatA", second))

    // The displaced holder unwinds and releases: a no-op, because it no longer owns it.
    run(releaseSessionRun("supersede", "chatA", first))
    expect(run(reserveSessionRun("supersede", "chatA", {}))).toBe(false)

    // The real holder's release does free it.
    run(releaseSessionRun("supersede", "chatA", second))
    expect(run(anySessionRunActive)).toBe(false)
  })

  it("releasing an unknown owner is a harmless no-op", () => {
    expect(() => run(releaseSessionRun("ghost", "nobody", h))).not.toThrow()
    expect(run(anySessionRunActive)).toBe(false)
  })
})
