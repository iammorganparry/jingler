import { describe, expect, it } from "vitest"
import { planExecutionNote, planNote } from "./plan-prompt.js"

describe("planNote", () => {
  it("requires the shared Jingler plan tool in read-only mode", () => {
    const note = planNote()
    expect(note).toContain("READ-ONLY")
    expect(note).toContain("jingler_submit_plan")
    expect(note).not.toContain("```json")
  })
})

describe("planExecutionNote", () => {
  it("keeps implementation with the main agent and breaks stale missing-tool claims", () => {
    const note = planExecutionNote()
    expect(note).toContain("Implement plan stages YOURSELF")
    // A session that was once genuinely tool-less anchors on its own prior
    // "no edit or command tools" statements forever; the per-turn note must
    // out-rank that stale context.
    expect(note).toContain("active tool list is the only authority")
    expect(note).toContain("without attempting the call in this turn")
    // The old policy told the model to hand whole stages to sub-agents.
    expect(note).not.toContain("delegate stage work")
  })
})
