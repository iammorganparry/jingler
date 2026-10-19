import { describe, expect, it } from "vitest"
import { layerRangeByNumber, prLayerRanges } from "./pr-stack.js"

const stack = [
  { number: 480, branch: "feat/a", base: "main" },
  { number: 481, branch: "feat/b", base: "feat/a" },
  { number: 482, branch: "feat/c", base: "feat/b" }
]

describe("prLayerRanges", () => {
  it("diffs the bottom layer against the base branch", () => {
    expect(prLayerRanges(stack, "main")[0]).toEqual({
      number: 480, base: "main", head: "feat/a", commitRange: "main..feat/a", diffRange: "main...feat/a"
    })
  })

  it("measures each upper layer against the layer below, excluding lower-layer commits", () => {
    const ranges = prLayerRanges(stack, "main")
    expect(ranges.map((r) => r.commitRange)).toEqual(["main..feat/a", "feat/a..feat/b", "feat/b..feat/c"])
    expect(ranges.map((r) => r.diffRange)).toEqual(["main...feat/a", "feat/a...feat/b", "feat/b...feat/c"])
  })

  it("ignores a stale stored base after a restack", () => {
    const stale = [stack[0]!, { number: 481, branch: "feat/b", base: "main" }]
    expect(prLayerRanges(stale, "main")[1]!.base).toBe("feat/a")
  })

  it("falls back to the trunk for a bottom layer with no stored base, and null when a branch is unknown", () => {
    const [bottom, upper] = prLayerRanges([{ number: 1, branch: "x" }, { number: 2 }], "develop")
    expect(bottom!.commitRange).toBe("develop..x")
    expect(upper).toEqual({ number: 2, base: "x", head: null, commitRange: null, diffRange: null })
  })
})

describe("layerRangeByNumber", () => {
  it("finds the range for a given layer number", () => {
    const ranges = prLayerRanges(stack, "main")
    expect(layerRangeByNumber(ranges, 481)).toEqual(ranges[1])
  })

  it("returns null when the number isn't in the stack", () => {
    expect(layerRangeByNumber(prLayerRanges(stack, "main"), 999)).toBeNull()
  })
})
