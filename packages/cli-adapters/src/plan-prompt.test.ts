import { describe, expect, it } from "vitest"
import { planNote } from "./plan-prompt.js"

describe("planNote", () => {
  it("requires the shared Jingler plan tool in read-only mode", () => {
    const note = planNote()
    expect(note).toContain("READ-ONLY")
    expect(note).toContain("jingler_submit_plan")
    expect(note).not.toContain("```json")
  })
})
