import { describe, expect, it } from "vitest"
import { PLAN_JSON_REFORMAT, planJsonInstructions } from "./plan-json.js"
import { planNote } from "./plan-prompt.js"

describe("planNote", () => {
  it("uses Claude's native plan transport while Codex receives the shared JSON protocol", () => {
    expect(planNote("claude")).toBeNull()
    expect(planNote("codex")).toContain("```json")
    expect(planNote("codex")).toContain("READ-ONLY")
    expect(planNote("codex")).not.toContain("ExitPlanMode")
  })

  it("keeps enhanced plans single-agent and provider-neutral", () => {
    const contract = planJsonInstructions()
    expect(contract).toContain('FIRST section must be titled "TL;DR"')
    expect(contract).toContain('"tasks": [{ "id", "text", "status": "pending" }]')
    expect(contract).toContain('"walkthrough": PlanBlock[]')
    expect(contract).toContain("tutorial-style walkthrough")
    expect(contract).toContain("Put every diagram in its owning stage")
    expect(contract).toContain('"testReferences": [{ "path", "cases": string[] }]')
    expect(contract).toContain("Do not add assignment, agent, harness, model, worker, or routing fields")
    expect(contract).not.toContain("data-agent-id")
    expect(planNote("codex")).toContain(contract)

    const reformat = PLAN_JSON_REFORMAT("- plan.stages.0.tasks: is missing")
    expect(reformat).toContain("TL;DR")
    expect(reformat).toContain("tasks")
    expect(reformat).toContain("walkthrough")
    expect(reformat).toContain("testReferences")
  })
})
