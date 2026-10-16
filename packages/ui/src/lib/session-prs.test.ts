import { describe, expect, it } from "vitest"
import type { SubagentFleetNode } from "@jingler/core"
import { sessionPrRows } from "./session-prs.js"

const node = (overrides: Partial<SubagentFleetNode>): SubagentFleetNode => ({
  id: "n1",
  subagentId: "s1",
  orchestrationRunId: "r1",
  nodeKind: "agent",
  registryRevision: 1,
  childSequence: 1,
  runId: "run1",
  parentId: null,
  parentRuntimeSessionId: "parent",
  agent: "reviewer",
  task: "do stuff",
  model: null,
  status: "running",
  health: "connected",
  phase: null,
  blocking: null,
  terminal: null,
  background: false,
  sessionFile: null,
  currentTool: null,
  startedAt: 0,
  updatedAt: 0,
  completedAt: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
  artifacts: [],
  attention: null,
  workspace: null,
  prNumber: null,
  ...overrides
})

describe("sessionPrRows", () => {
  it("lists main PRs first as agent \"main\"", () => {
    expect(sessionPrRows([482], [])).toEqual([{ number: 482, agent: "main", branch: null }])
  })

  it("adds a row for each fleet node with a prNumber", () => {
    const rows = sessionPrRows([482], [
      node({ prNumber: 491, agent: "reviewer", workspace: { path: "/x", branch: "fix/491", baseRef: null } }),
      node({ prNumber: null })
    ])
    expect(rows).toEqual([
      { number: 482, agent: "main", branch: null },
      { number: 491, agent: "reviewer", branch: "fix/491", state: "running" }
    ])
  })

  it("dedupes by PR number, keeping the main row when a child shares its number", () => {
    const rows = sessionPrRows([482], [node({ prNumber: 482, agent: "reviewer" })])
    expect(rows).toEqual([{ number: 482, agent: "main", branch: null }])
  })

  it("returns an empty array when there are no PRs", () => {
    expect(sessionPrRows([], [])).toEqual([])
  })
})
