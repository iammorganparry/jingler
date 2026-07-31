import { describe, expect, it } from "vitest"
import {
  claimPlanAutoPresentation,
  clearPlanAutoPresentation
} from "./plan-presence.js"

describe("plan auto-presentation", () => {
  it("allows only the first plan-producing turn to auto-open per session", () => {
    const sessionId = "session-first-plan"

    expect(claimPlanAutoPresentation(sessionId)).toBe(true)
    expect(claimPlanAutoPresentation(sessionId)).toBe(false)
  })

  it("tracks sessions independently and resets only when a session is deleted", () => {
    const first = "session-reset-first-plan"
    const second = "session-independent-plan"

    expect(claimPlanAutoPresentation(first)).toBe(true)
    expect(claimPlanAutoPresentation(second)).toBe(true)
    expect(claimPlanAutoPresentation(first)).toBe(false)

    clearPlanAutoPresentation(first)

    expect(claimPlanAutoPresentation(first)).toBe(true)
    expect(claimPlanAutoPresentation(second)).toBe(false)
  })
})
