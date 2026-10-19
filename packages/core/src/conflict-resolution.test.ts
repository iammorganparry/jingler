import { describe, expect, it } from "vitest"
import { conflictResolutionPrompt } from "./conflict-resolution.js"

describe("conflictResolutionPrompt", () => {
  it("names every conflicting file", () => {
    const prompt = conflictResolutionPrompt(["a.ts", "b/c.ts"])
    expect(prompt).toContain("a.ts")
    expect(prompt).toContain("b/c.ts")
  })

  it("uses singular phrasing for one file", () => {
    expect(conflictResolutionPrompt(["a.ts"])).toContain("this file")
  })

  it("uses plural phrasing for multiple files", () => {
    expect(conflictResolutionPrompt(["a.ts", "b.ts"])).toContain("these files")
  })
})
