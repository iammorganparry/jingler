import { describe, expect, it } from "vitest"
import { BUILTIN_TAB, builtinTabContributions, describeTab, type TabContext } from "./tab-contributions.js"
import { testSession } from "../test-support.js"

const checks = builtinTabContributions({ conversation: () => null, stub: () => null }).find((c) => c.id === BUILTIN_TAB.checks)!
const ctx = (over: Partial<TabContext>): TabContext => ({ session: testSession({ id: "a", prNumber: 7 }), hasPlan: false, ...over })

describe("Checks tab contribution", () => {
  it("is labelled Checks and badges passing/total CI checks", () => {
    expect(checks.label).toBe("Checks")
    expect(describeTab(checks, ctx({ checkCounts: { passing: 3, total: 4 } })).badge).toEqual({ kind: "count", text: "3/4" })
  })

  it("has no count without a PR or without checks", () => {
    const noPr = ctx({ session: testSession({ id: "a", prNumber: null }), checkCounts: { passing: 3, total: 4 } })
    expect(describeTab(checks, noPr).badge).toBeUndefined()
    expect(describeTab(checks, ctx({ checkCounts: null })).badge).toBeUndefined()
    expect(describeTab(checks, ctx({ checkCounts: { passing: 0, total: 0 } })).badge).toBeUndefined()
  })
})
