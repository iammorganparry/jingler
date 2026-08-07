// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  clampedPlanSplitRatio,
  DEFAULT_PLAN_SPLIT_RATIO,
  resizedPlanSplitRatio
} from "./plan-split-ratio.js"

describe("conversation/plan split ratio", () => {
  it("starts with two thirds for the plan and resizes continuously", () => {
    expect(DEFAULT_PLAN_SPLIT_RATIO).toBeCloseTo(2 / 3)
    expect(clampedPlanSplitRatio(DEFAULT_PLAN_SPLIT_RATIO, 1_200)).toBeCloseTo(2 / 3)
    expect(resizedPlanSplitRatio(0.5, 1_000, -100)).toBeCloseTo(0.6)
    expect(resizedPlanSplitRatio(0.6, 1_000, 50)).toBeCloseTo(0.55)
  })

  it("preserves a usable 360px minimum for both columns", () => {
    expect(clampedPlanSplitRatio(0.9, 801)).toBeCloseTo(0.55)
    expect(clampedPlanSplitRatio(0.1, 801)).toBeCloseTo(0.45)
    expect(clampedPlanSplitRatio(0.9, 721)).toBe(0.5)
  })
})
