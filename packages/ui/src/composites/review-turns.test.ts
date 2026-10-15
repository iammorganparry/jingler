import type { Message } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { agentEditsOf, narrowToTurn, reviewTurnsOf } from "./review-turns.js"

const tool = (path: string) =>
  ({ _tag: "Tool", tool: { fileChanges: { changes: [{ path }] } } }) as never
const message = (id: string, role: "user" | "assistant", ...paths: string[]): Message =>
  ({ id, role, parts: paths.map(tool) }) as never

describe("review turns", () => {
  const messages = [
    message("u1", "user"),
    message("a1", "assistant", "src/a.ts", "src/b.ts"),
    message("u2", "user"),
    message("a2", "assistant"),
    message("a3", "assistant", "src/b.ts", "src/b.ts", "docs/c.md")
  ]

  it("lists only assistant turns that changed files, numbered among all assistant turns", () => {
    expect(reviewTurnsOf(messages)).toEqual([
      { id: "a1", label: "Turn 1", paths: ["src/a.ts", "src/b.ts"] },
      { id: "a3", label: "Turn 3", paths: ["src/b.ts", "docs/c.md"] }
    ])
  })

  it("narrows files and diffs to the selected turn, and keeps everything for no turn", () => {
    const [first] = reviewTurnsOf(messages)
    const files = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "docs/c.md" }]
    expect(narrowToTurn(files, first!).map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(narrowToTurn(files, null)).toBe(files)
  })

  it("lists the edits to one path, labelled with the turn number", () => {
    const edits = agentEditsOf(messages, "src/b.ts")
    expect(edits.map((edit) => [edit.turnId, edit.label])).toEqual([
      ["a1", "Agent edit · Turn 1"],
      ["a3", "Agent edit · Turn 3"],
      ["a3", "Agent edit · Turn 3"]
    ])
    expect(agentEditsOf(messages, "missing.ts")).toEqual([])
  })
})
