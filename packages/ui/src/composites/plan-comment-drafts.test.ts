import { describe, expect, it } from "vitest"
import { countUnsavedDrafts, discardCommentsTitle, planDraftCount, setPlanDraftCount } from "./plan-comment-drafts.js"

describe("plan comment drafts", () => {
  it("counts only non-blank new-comment and reply drafts", () => {
    expect(countUnsavedDrafts("", {})).toBe(0)
    expect(countUnsavedDrafts("  ", { a: "" })).toBe(0)
    expect(countUnsavedDrafts("note", { a: "reply", b: " " })).toBe(2)
  })

  it("pluralizes the title", () => {
    expect(discardCommentsTitle(1)).toBe("Discard 1 unsaved comment?")
    expect(discardCommentsTitle(2)).toBe("Discard 2 unsaved comments?")
  })

  it("tracks and clears the mounted draft count", () => {
    setPlanDraftCount("s:c", 2)
    expect(planDraftCount("s:c")).toBe(2)
    setPlanDraftCount("s:c", 0)
    expect(planDraftCount("s:c")).toBe(0)
  })
})
