import { describe, expect, it } from "vitest"
import { questionNote } from "./question-prompt.js"

describe("questionNote", () => {
  it("requires Jingler's structured question tool", () => {
    const note = questionNote()
    expect(note).toContain("Never ask in prose")
    expect(note).toContain("stop and wait")
    expect(note).toContain("jingler_ask_question")
  })

  it("says when not to ask", () => {
    expect(questionNote()).toContain("sensible default")
  })

  it("does not advertise a provider-native question channel", () => {
    expect(questionNote()).not.toContain("AskUserQuestion")
    expect(questionNote()).not.toContain("```question")
  })
})
