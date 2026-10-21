// @vitest-environment node
import { describe, expect, it } from "vitest"
import { scopeBarState, scopedPrNumber, terminalCwd } from "./subagent-scope.js"

const ws = (diff?: { added: number; removed: number }) => ({
  workspace: { path: "/w/child", branch: "b", baseRef: "main", ...(diff ? { diff } : {}) }
})

describe("subagent-scope", () => {
  it("terminalCwd prefers the viewed child's worktree", () => {
    expect(terminalCwd(ws(), "/w/main")).toBe("/w/child")
    expect(terminalCwd({ workspace: null }, "/w/main")).toBe("/w/main")
    expect(terminalCwd(null, null)).toBeUndefined()
  })
  it("scopedPrNumber only applies while scoped to the viewed child", () => {
    const child = { subagentId: "a", prNumber: 491, workspace: null }
    expect(scopedPrNumber(child, "a")).toBe(491)
    expect(scopedPrNumber(child, "all")).toBeNull()
    expect(scopedPrNumber(null, "a")).toBeNull()
  })
  it("scopeBarState distinguishes active, empty and removed", () => {
    expect(scopeBarState(ws(), 2)).toBe("active")
    expect(scopeBarState(ws(), 0)).toBe("empty")
    expect(scopeBarState(ws({ added: 3, removed: 0 }), 0)).toBe("removed")
  })
})
