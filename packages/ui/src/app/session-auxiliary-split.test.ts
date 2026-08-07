import { describe, expect, it } from "vitest"
import {
  clampedSessionAuxiliaryRatio,
  DEFAULT_SESSION_AUXILIARY_RATIO,
  resizedSessionAuxiliaryRatio
} from "./session-auxiliary-split.js"

describe("session auxiliary split ratio", () => {
  it("starts with two thirds for the selected view and resizes continuously", () => {
    expect(DEFAULT_SESSION_AUXILIARY_RATIO).toBeCloseTo(2 / 3)
    expect(resizedSessionAuxiliaryRatio(2 / 3, 1_200, 120)).toBeCloseTo(0.5666, 2)
    expect(resizedSessionAuxiliaryRatio(0.6, 1_200, -120)).toBeCloseTo(0.7, 2)
  })

  it("preserves usable minimum widths for chat and the selected view", () => {
    expect(clampedSessionAuxiliaryRatio(0.1, 1_200)).toBeCloseTo(480 / 1_199)
    expect(clampedSessionAuxiliaryRatio(0.95, 1_200)).toBeCloseTo(1 - 320 / 1_199)
  })
})
