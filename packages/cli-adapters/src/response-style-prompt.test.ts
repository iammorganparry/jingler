import { responseStyleOf } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { responseStyleNote } from "./response-style-prompt.js"

describe("responseStyleNote", () => {
  it("gives each style its own instruction", () => {
    expect(responseStyleNote("concise")).toContain("couple of sentences")
    expect(responseStyleNote("balanced")).toContain("up to five bullets")
    expect(responseStyleNote("elaborate")).toContain("file by file")
    expect(responseStyleNote("adhd")).toContain("First line is an action")
  })

  it("lets the operator override the level on request", () => {
    expect(responseStyleNote("concise")).toContain("unless the operator explicitly asks")
  })
})

describe("responseStyleOf", () => {
  it("defaults to concise", () => {
    expect(responseStyleOf(null)).toBe("concise")
    expect(responseStyleOf({})).toBe("concise")
  })

  it("maps a legacy adhdMode: true to the adhd style", () => {
    expect(responseStyleOf({ adhdMode: true })).toBe("adhd")
    expect(responseStyleOf({ adhdMode: false })).toBe("concise")
  })

  it("prefers an explicit responseStyle over legacy adhdMode", () => {
    expect(responseStyleOf({ adhdMode: true, responseStyle: "balanced" })).toBe("balanced")
  })
})
