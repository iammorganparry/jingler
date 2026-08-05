import type { SelectedLineRange } from "@pierre/diffs"
import { describe, expect, it } from "vitest"
import {
  fromPierreCodeViewSelection,
  fromPierreSelectedLineRange,
  isSingleSideSelection,
  selectionAnnotationAnchor,
  toPierreCodeViewSelection,
  toPierreSelectedLineRange,
  type JinglerLineSelection
} from "./pierre-selection.js"

describe("Pierre selection adapters", () => {
  it.each([
    {
      name: "deletion-only",
      range: { start: 8, end: 10, side: "deletions", endSide: "deletions" },
      expected: { side: "old", startLine: 8, endLine: 10, endSide: "old" }
    },
    {
      name: "addition-only",
      range: { start: 2, end: 4, side: "additions", endSide: "additions" },
      expected: { side: "new", startLine: 2, endLine: 4, endSide: "new" }
    },
    {
      name: "context",
      range: { start: 6, end: 6 },
      expected: { side: "new", startLine: 6, endLine: 6, endSide: "new" }
    },
    {
      name: "cross-side multiline",
      range: { start: 3, end: 5, side: "deletions", endSide: "additions" },
      expected: { side: "old", startLine: 3, endLine: 5, endSide: "new" }
    }
  ] satisfies ReadonlyArray<{
    name: string
    range: SelectedLineRange
    expected: Omit<JinglerLineSelection, "path">
  }>)("preserves $name coordinates and inclusive boundaries", ({ range, expected }) => {
    expect(fromPierreSelectedLineRange("./src\\review.ts", range)).toEqual({
      path: "src/review.ts",
      ...expected
    })
  })

  it("round-trips CodeView identity, sides, and inclusive line numbers", () => {
    const selection: JinglerLineSelection = {
      path: "src/review.ts",
      side: "old",
      startLine: 12,
      endLine: 15,
      endSide: "new"
    }

    expect(
      fromPierreCodeViewSelection(toPierreCodeViewSelection(selection))
    ).toEqual(selection)
    expect(toPierreSelectedLineRange(selection)).toEqual({
      start: 12,
      side: "deletions",
      end: 15,
      endSide: "additions"
    })
    expect(isSingleSideSelection(selection)).toBe(false)
    expect(selectionAnnotationAnchor(selection)).toEqual({
      lineNumber: 15,
      side: "new"
    })
  })

  it("rejects zero, negative, fractional, and non-finite line coordinates", () => {
    expect(() =>
      fromPierreSelectedLineRange("a.ts", { start: 0, end: 1 })
    ).toThrow(/positive one-indexed/)
    expect(() =>
      fromPierreSelectedLineRange("a.ts", { start: 1, end: 1.5 })
    ).toThrow(/positive one-indexed/)
    expect(() =>
      toPierreSelectedLineRange({
        path: "a.ts",
        side: "new",
        startLine: 1,
        endLine: Number.POSITIVE_INFINITY,
        endSide: "new"
      })
    ).toThrow(/positive one-indexed/)
  })
})
