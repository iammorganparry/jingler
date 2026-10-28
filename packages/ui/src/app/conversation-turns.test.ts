import type { Message } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { summarizeTurn, turnRailMeta } from "./conversation-turns.js"

const tool = (status: "success" | "error", target: string, added = 0, removed = 0) => ({
  _tag: "Tool" as const,
  tool: { id: target, name: "Edit", target, status, meta: null, diff: { added, removed }, preview: null }
})
const assistant = (...parts: Message["parts"][number][]): Message => ({
  id: "a", role: "assistant", streaming: false, createdAt: "2026-01-01T00:00:00.000Z", parts
})

describe("summarizeTurn", () => {
  it("totals files and lines across a turn", () => {
    const summary = summarizeTurn([assistant(tool("success", "a.ts", 80, 10), tool("success", "b.ts", 4, 2), tool("success", "a.ts", 0, 0))])
    expect(summary).toEqual({ attention: undefined, files: 2, added: 84, removed: 12 })
    expect(turnRailMeta(3, summary)).toBe("Turn 3 · 2 files · +84 −12")
    expect(turnRailMeta(1, { ...summary, files: 1 })).toBe("Turn 1 · 1 file · +84 −12")
    expect(turnRailMeta(2, summarizeTurn([]))).toBe("Turn 2")
  })

  it("flags a blocked question as needs-you and an errored last tool as failed", () => {
    const question = { _tag: "Question" as const, request: { id: "q", questions: [] }, answers: null }
    expect(summarizeTurn([assistant(question)]).attention).toBe("needs-you")
    expect(summarizeTurn([assistant({ ...question, answers: [] })]).attention).toBeUndefined()
    expect(summarizeTurn([assistant(tool("error", "a.ts"))]).attention).toBe("failed")
    expect(summarizeTurn([assistant(tool("error", "a.ts"), tool("success", "a.ts"))]).attention).toBeUndefined()
  })

  it("flags needs-you when a child subagent is awaiting attention", () => {
    expect(summarizeTurn([assistant(tool("success", "a.ts"))], true).attention).toBe("needs-you")
    expect(summarizeTurn([assistant(tool("success", "a.ts"))], false).attention).toBeUndefined()
    expect(summarizeTurn([assistant(tool("success", "a.ts"))]).attention).toBeUndefined()
  })
})
