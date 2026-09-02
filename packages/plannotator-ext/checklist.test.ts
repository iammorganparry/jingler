import { describe, expect, it } from "vitest"
import { extractProgressMarkers, updateChecklistStatuses } from "./generated/checklist.ts"

describe("progress markers", () => {
  it("parses every supported status in program order", () => {
    expect(extractProgressMarkers(
      "[ACTIVE:1] [DONE:2] [BLOCKED:3] [SKIPPED:4] [FAILED:5] [INTERRUPTED:6]"
    )).toEqual([
      { step: 1, status: "in-progress" },
      { step: 2, status: "completed" },
      { step: 3, status: "blocked" },
      { step: 4, status: "skipped" },
      { step: 5, status: "failed" },
      { step: 6, status: "interrupted" }
    ])
  })
})

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

  it("ignores CommonMark fences with info strings, tildes, and longer markers", () => {
    const plan = [
      "````md title=\"example\"",
      "- [ ] Backtick example",
      "```",
      "````",
      "~~~ markdown example",
      "- [ ] Tilde example",
      "~~~~",
      "- [ ] Real step",
      ""
    ].join("\n")

    expect(updateChecklistStatuses(plan, new Map([[1, "completed"]]))).toBe(
      plan.replace("- [ ] Real step", "- [x] Real step")
    )
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
