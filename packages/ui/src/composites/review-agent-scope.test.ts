import { describe, expect, it } from "vitest"
import { mergeAgentTrees, sumAgentRows, type AgentTreeChanges } from "./review-agent-scope.js"

const file = (path: string, additions: number, deletions: number) =>
  ({ path, additions, deletions, commentCount: 0, viewed: false })

const trees: readonly AgentTreeChanges[] = [
  { agentId: null, label: "Main", files: [file("src/a.ts", 1, 0), file("src/shared.ts", 2, 1)] },
  { agentId: "n1", label: "worker", files: [file("src/shared.ts", 5, 5), file("src/b.ts", 3, 0)] }
]

describe("mergeAgentTrees", () => {
  it("All agents: a file edited in two trees shows one row per agent, path-ordered", () => {
    const rows = mergeAgentTrees(trees, "all")
    expect(rows.map((row) => `${row.file.path}@${row.label}`)).toEqual([
      "src/a.ts@Main",
      "src/b.ts@worker",
      "src/shared.ts@Main",
      "src/shared.ts@worker"
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(4)
  })

  it("sums every tree in the header", () => {
    expect(sumAgentRows(mergeAgentTrees(trees, "all"))).toEqual({ added: 11, removed: 6 })
  })

  it("Main hides child files; one agent shows only its tree", () => {
    expect(mergeAgentTrees(trees, "main").map((row) => row.label)).toEqual(["Main", "Main"])
    expect(mergeAgentTrees(trees, "n1").map((row) => row.file.path)).toEqual([
      "src/b.ts",
      "src/shared.ts"
    ])
  })
})
