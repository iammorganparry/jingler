import { describe, expect, it } from "vitest"
import { adhdNote } from "./adhd-prompt.js"

describe("adhdNote", () => {
  it("defines provider-independent completion rules inline", () => {
    const note = adhdNote()
    expect(note).toContain("First line is an action")
    expect(note).toContain("End with ONE next action")
    expect(note).not.toContain("i-have-adhd")
  })

  it("limits the format to a finished task's completion summary", () => {
    const note = adhdNote()
    expect(note).toContain("final completion summary")
    expect(note).toContain("working updates")
    expect(note).toContain("planning")
    expect(note).toContain("questions")
  })
})
