import { describe, expect, it } from "vitest"
import { updateChecklistStatuses } from "./generated/checklist.ts"

describe("updateChecklistStatuses", () => {
  it("updates markers by document order without changing task text or nesting", () => {
    const plan = [
      "## Stage one",
      "- [ ] Duplicate",
      "  - [ ] Nested",
      "- [x] Duplicate",
      "",
      "### Acceptance",
      "* [ ] Verified",
      ""
    ].join("\n")

    expect(updateChecklistStatuses(plan, new Map([
      [1, "in-progress"],
      [2, "blocked"],
      [3, "pending"],
      [4, "completed"]
    ]))).toBe([
      "## Stage one",
      "- [~] Duplicate",
      "  - [-] Nested",
      "- [ ] Duplicate",
      "",
      "### Acceptance",
      "* [x] Verified",
      ""
    ].join("\n"))
  })

  it("ignores fenced and empty checkboxes when numbering updates", () => {
    const plan = [
      "```md",
      "- [ ] Example only",
      "```",
      "- [ ]",
      "- [ ] Real step",
      ""
    ].join("\n")

    expect(updateChecklistStatuses(plan, new Map([[1, "completed"]]))).toBe([
      "```md",
      "- [ ] Example only",
      "```",
      "- [ ]",
      "- [x] Real step",
      ""
    ].join("\n"))
  })

  it("keeps acceptance criteria binary", () => {
    const plan = [
      "## Stage",
      "- [ ] Implement",
      "### Acceptance",
      "- [ ] Verify",
      ""
    ].join("\n")

    expect(updateChecklistStatuses(plan, new Map([
      [1, "blocked"],
      [2, "in-progress"]
    ]))).toBe([
      "## Stage",
      "- [-] Implement",
      "### Acceptance",
      "- [ ] Verify",
      ""
    ].join("\n"))
  })

  it("leaves content unchanged for missing steps", () => {
    const plan = "- [ ] One\n"
    expect(updateChecklistStatuses(plan, new Map([[3, "completed"]]))).toBe(plan)
  })
})
