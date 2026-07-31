// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  clampedPlanSplitRatio,
  resizedPlanSplitRatio
} from "./plan-split-ratio.js"

describe("conversation/plan split ratio", () => {
  it("starts equal and resizes continuously in container-relative units", () => {
    expect(clampedPlanSplitRatio(0.5, 1_000)).toBe(0.5)
    expect(resizedPlanSplitRatio(0.5, 1_000, -100)).toBe(0.6)
    expect(resizedPlanSplitRatio(0.6, 1_000, 50)).toBeCloseTo(0.55)
  })

  it("preserves a usable 360px minimum for both columns", () => {
    expect(clampedPlanSplitRatio(0.9, 800)).toBeCloseTo(0.55)
    expect(clampedPlanSplitRatio(0.1, 800)).toBeCloseTo(0.45)
  })
})
