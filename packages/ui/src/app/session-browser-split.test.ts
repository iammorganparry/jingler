import { describe, expect, it } from "vitest"
import {
  clampedSessionBrowserRatio,
  DEFAULT_SESSION_BROWSER_RATIO,
  resizedSessionBrowserRatio
} from "./session-browser-split.js"

describe("session browser split ratio", () => {
  it("starts with two thirds for Browser and resizes continuously", () => {
    expect(DEFAULT_SESSION_BROWSER_RATIO).toBeCloseTo(2 / 3)
    expect(resizedSessionBrowserRatio(2 / 3, 1_200, 120)).toBeCloseTo(0.5666, 2)
    expect(resizedSessionBrowserRatio(0.6, 1_200, -120)).toBeCloseTo(0.7, 2)
  })

  it("preserves usable minimum widths for chat and Browser", () => {
    expect(clampedSessionBrowserRatio(0.1, 1_200)).toBeCloseTo(480 / 1_199)
    expect(clampedSessionBrowserRatio(0.95, 1_200)).toBeCloseTo(1 - 320 / 1_199)
  })
})
