import { describe, expect, it } from "vitest"
import { explorerMarkFor, explorerRowMarks } from "./explorer-row-marks.js"

const entries = [
  { path: "src/a/one.ts", status: "modified" as const },
  { path: "src/a/two.ts", status: "clean" as const },
  { path: "src/b/new.ts", status: "untracked" as const },
  { path: "docs/readme.md", status: "clean" as const }
]

describe("explorerRowMarks", () => {
  it("maps git letters and marks every ancestor folder of a changed file", () => {
    const marks = explorerRowMarks(entries, [], null)
    expect(marks.get("src/a/one.ts")?.letter).toBe("M")
    expect(marks.get("src/b/new.ts")?.letter).toBe("U")
    expect(marks.get("src/a/two.ts")).toBeUndefined()
    expect(marks.get("src")?.changedDescendant).toBe(true)
    expect(marks.get("src/a")?.changedDescendant).toBe(true)
    expect(marks.get("docs")).toBeUndefined()
  })

  it("flags agent-edited files and pulses only the one being edited now", () => {
    const marks = explorerRowMarks(entries, ["src/a/two.ts", "src/a/one.ts"], "src/a/two.ts")
    expect(marks.get("src/a/two.ts")).toMatchObject({ agentEdited: true, editingNow: true })
    expect(marks.get("src/a/one.ts")).toMatchObject({ agentEdited: true, editingNow: false, letter: "M" })
    expect(marks.get("src/a")?.changedDescendant).toBe(true)
  })

  it("stops pulsing when the run ends but keeps the agent dot", () => {
    const marks = explorerRowMarks(entries, ["src/a/two.ts"], null)
    expect(marks.get("src/a/two.ts")).toMatchObject({ agentEdited: true, editingNow: false })
  })

  it("finds folder marks by Pierre's trailing-slash item path", () => {
    const marks = explorerRowMarks(entries, [], null)
    expect(explorerMarkFor(marks, "src/a/")?.changedDescendant).toBe(true)
  })
})
