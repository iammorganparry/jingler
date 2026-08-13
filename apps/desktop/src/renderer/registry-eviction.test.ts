import { describe, expect, it } from "vitest"
import type { LruCandidate } from "./registry-eviction.js"
import { lruKeysToEvict } from "./registry-eviction.js"

const free = (key: string, pinned = false): LruCandidate => ({ key, pinned })

/** LRU-first list of `n` unpinned residents, keys `s1` … `sN`. */
const residents = (n: number): ReadonlyArray<LruCandidate> =>
  Array.from({ length: n }, (_, i) => free(`s${i + 1}`))

describe("lruKeysToEvict", () => {
  it("evicts nothing while at or under the cap", () => {
    expect(lruKeysToEvict(residents(6), { keep: "s6", max: 6 })).toEqual([])
  })

  it("evicts least-recently-used first, and only down to the cap", () => {
    expect(lruKeysToEvict(residents(9), { keep: "s9", max: 6 })).toEqual(["s1", "s2", "s3"])
  })

  it("never evicts the key it was told to keep", () => {
    // The just-created actor is the LRU entry by insertion order on the first
    // switch; evicting it would drop the resource being opened.
    const candidates = [free("fresh"), ...residents(8)]
    const evicted = lruKeysToEvict(candidates, { keep: "fresh", max: 6 })
    expect(evicted).not.toContain("fresh")
    expect(evicted).toEqual(["s1", "s2", "s3"])
  })

  it("skips pinned residents and evicts further down instead", () => {
    // Nine residents, cap of six, so three must go — but the two oldest are pinned,
    // so the cap is met from s3 onwards rather than stopping short.
    const candidates = [
      free("s1", true),
      free("s2", true),
      ...residents(9).slice(2)
    ]
    expect(lruKeysToEvict(candidates, { keep: "s9", max: 6 })).toEqual(["s3", "s4", "s5"])
  })

  it("stays over the cap rather than dropping pinned work", () => {
    // Every resident is pinned (a dirty draft, or a mounted surface). A memory cap
    // is not worth losing unsaved work or blanking a live view.
    const pinned = residents(10).map((c) => ({ ...c, pinned: true }))
    expect(lruKeysToEvict(pinned, { keep: "s10", max: 6 })).toEqual([])
  })

  it("honours the cap it is given", () => {
    expect(lruKeysToEvict(residents(3), { keep: "s3", max: 1 })).toEqual(["s1", "s2"])
  })
})
