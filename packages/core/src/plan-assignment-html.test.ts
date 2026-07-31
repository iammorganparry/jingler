import { parse } from "node-html-parser"
import { describe, expect, it } from "vitest"
import { writePlanAssignmentReasoningAttributes } from "./plan-assignment-html.js"

describe("writePlanAssignmentReasoningAttributes", () => {
  it("writes and clears the complete canonical reasoning route", () => {
    const element = parse("<div data-assignment></div>").querySelector("div")!

    writePlanAssignmentReasoningAttributes(element, {
      enabled: true,
      effort: "high"
    })
    expect(element.getAttribute("data-thinking-enabled")).toBe("true")
    expect(element.getAttribute("data-reasoning-effort")).toBe("high")

    writePlanAssignmentReasoningAttributes(element, undefined)
    expect(element.hasAttribute("data-thinking-enabled")).toBe(false)
    expect(element.hasAttribute("data-reasoning-effort")).toBe(false)
  })
})
