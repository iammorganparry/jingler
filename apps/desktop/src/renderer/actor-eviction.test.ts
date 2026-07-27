import { describe, expect, it } from "vitest"
import type { ActivityPhase } from "@jingler/core"
import { MAX_LIVE_ACTORS, isEvictable, keysToEvict } from "./actor-eviction.js"
import type { ActorCandidate } from "./actor-eviction.js"

const idle = (key: string, overrides: Partial<ActorCandidate> = {}): ActorCandidate => ({
  key,
  sessionId: key.split(":")[0] ?? key,
  phase: "idle" as ActivityPhase,
  queuedCount: 0,
  pendingText: "",
  ...overrides
})

/** LRU-first list of `n` idle actors, keys `s1:c` … `sN:c`. */
const residents = (n: number): ReadonlyArray<ActorCandidate> =>
  Array.from({ length: n }, (_, i) => idle(`s${i + 1}:c`))

const nothingVisible = () => false

describe("isEvictable", () => {
  it("evicts a plain idle, off-screen actor", () => {
    expect(isEvictable(idle("s1:c"), nothingVisible)).toBe(true)
  })

  it("keeps an actor whose run is still in flight", () => {
    // Stopping it interrupts the RPC stream and kills the run in main — the exact
    // thing the hoisted registry exists to prevent.
    expect(isEvictable(idle("s1:c", { phase: "running" }), nothingVisible)).toBe(false)
    expect(isEvictable(idle("s1:c", { phase: "settling" }), nothingVisible)).toBe(false)
  })

  it("keeps an actor holding queued turns", () => {
    // Queued turns exist only in machine context; the transcript on disk cannot
    // restore them.
    expect(isEvictable(idle("s1:c", { queuedCount: 1 }), nothingVisible)).toBe(false)
  })

  it("keeps an actor holding unsent prompt text", () => {
    expect(isEvictable(idle("s1:c", { pendingText: "half a thought" }), nothingVisible)).toBe(false)
    // Whitespace is not work worth keeping an actor alive for.
    expect(isEvictable(idle("s1:c", { pendingText: "   \n" }), nothingVisible)).toBe(true)
  })

  it("keeps an actor whose session is on screen, including in another pane", () => {
    const visible = (id: string) => id === "s1"
    expect(isEvictable(idle("s1:c"), visible)).toBe(false)
    expect(isEvictable(idle("s2:c"), visible)).toBe(true)
  })
})

describe("keysToEvict", () => {
  it("evicts nothing while under the cap", () => {
    expect(
      keysToEvict(residents(MAX_LIVE_ACTORS), { keep: "s1:c", isVisible: nothingVisible })
    ).toEqual([])
  })

  it("evicts least-recently-used first, and only down to the cap", () => {
    // Nine residents, cap of six: exactly three go, and they are the three oldest.
    expect(keysToEvict(residents(9), { keep: "s9:c", isVisible: nothingVisible })).toEqual([
      "s1:c",
      "s2:c",
      "s3:c"
    ])
  })

  it("never evicts the key it was told to keep", () => {
    // The just-created actor is the LRU entry by insertion order on the very first
    // switch; evicting it would drop the transcript being opened.
    const candidates = [idle("fresh:c"), ...residents(8)]
    const evicted = keysToEvict(candidates, { keep: "fresh:c", isVisible: nothingVisible })
    expect(evicted).not.toContain("fresh:c")
    expect(evicted).toEqual(["s1:c", "s2:c", "s3:c"])
  })

  it("skips busy actors and evicts further down the list instead", () => {
    // Nine residents, cap of six, so three must go — but the two oldest are busy,
    // so the cap is met from s3 onwards instead of stopping short.
    const candidates = [
      idle("s1:c", { phase: "running" }),
      idle("s2:c", { queuedCount: 2 }),
      ...residents(9).slice(2)
    ]
    expect(keysToEvict(candidates, { keep: "s9:c", isVisible: nothingVisible })).toEqual([
      "s3:c",
      "s4:c",
      "s5:c"
    ])
  })

  it("stays over the cap rather than killing a live run", () => {
    // Every resident is streaming. A memory cap is not worth losing an agent's work.
    const busy = residents(10).map((c) => ({ ...c, phase: "running" as ActivityPhase }))
    expect(keysToEvict(busy, { keep: "s10:c", isVisible: nothingVisible })).toEqual([])
  })

  it("honours an explicit max", () => {
    expect(keysToEvict(residents(3), { keep: "s3:c", max: 1, isVisible: nothingVisible })).toEqual([
      "s1:c",
      "s2:c"
    ])
  })
})
