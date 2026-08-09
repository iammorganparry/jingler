import { describe, expect, it } from "vitest"
import { setSessionActivity } from "./session-activity.js"

describe("setSessionActivity", () => {
  it("accepts and clears activity from the selected workspace agent", () => {
    expect(() => {
      setSessionActivity("session-1", { kind: "thinking", verb: "Thinking", target: null })
      setSessionActivity("session-1", null)
    }).not.toThrow()
  })
})
