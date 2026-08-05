import { describe, expect, it } from "vitest"
import {
  planningOrchestrationRoutes,
  unavailableOrchestrationAssignment
} from "./agent-runner.js"
import { PLAN_JSON_REFORMAT, planJsonInstructions } from "./plan-json.js"
import { planNote } from "./plan-prompt.js"

describe("planNote", () => {
  it("is null for Claude, which has a real tool (planModeInstructions) to be steered toward", () => {
    expect(planNote("claude")).toBe(null)
  })

  it("is null for harnesses that cannot plan at all (cursor falls through to the stub)", () => {
    expect(planNote("cursor")).toBe(null)
  })

  it("advertises live provider models and rejects retired assignments", () => {
    const routes = planningOrchestrationRoutes([
      { cli: "opencode", models: [{ id: "user/provider-model", label: "User model" }] },
      { cli: "cursor", models: [{ id: "auto", label: "Auto" }] }
    ])
    expect(routes).toEqual([
      { cli: "opencode", models: [{ id: "user/provider-model", label: "User model" }] }
    ])
    const baseStage = {
      id: "01",
      title: "Implement",
      intent: "Ship it.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [],
      dependencies: [],
      complexity: "medium" as const,
      executionStatus: "queued" as const
    }
    expect(
      unavailableOrchestrationAssignment(
        [
          {
            ...baseStage,
            assignment: {
              agentId: "worker-a",
              cli: "opencode",
              model: "retired-model",
              reason: "Assigned by planner."
            }
          }
        ],
        routes
      )?.id
    ).toBe("01")
    expect(
      unavailableOrchestrationAssignment(
        [
          {
            ...baseStage,
            assignment: {
              agentId: "worker-a",
              cli: "opencode",
              model: "user/provider-model",
              reason: "Assigned by planner."
            }
          }
        ],
        routes
      )
    ).toBeNull()
  })

  it("hands codex and opencode the identical JSON protocol", () => {
    // The two differ only in transport. A note that drifted between them would
    // mean a plan decodes on one harness and degrades to raw text on the other.
    expect(planNote("codex")).toBe(planNote("opencode"))
    expect(planNote("codex")).toContain("```json")
  })

  it("tells the harness it is read-only, not merely that it should behave", () => {
    expect(planNote("codex")).toContain("READ-ONLY")
  })

  it("never tells a non-Claude harness to call ExitPlanMode", () => {
    expect(planNote("codex")).not.toContain("ExitPlanMode")
  })

  it("asks for structured semantics while reserving worker assignments for Jingler", () => {
    const note = planNote("codex") ?? ""
    // The DTO envelope + block grammar, no worker routing.
    expect(note).toContain('"mode"')
    expect(note).toContain('"stages"')
    expect(note).toContain("never emit worker assignments")
    expect(note).not.toContain("data-agent-id")
  })

  it("requires TLDR, detailed tasks, stage diagrams, and concrete test references", () => {
    // Claude receives this shared payload through planModeInstructions; Codex
    // and OpenCode receive the same payload inside their per-turn plan note.
    const contract = planJsonInstructions()
    expect(contract).toContain('FIRST section must be titled "TL;DR"')
    expect(contract).toContain('"tasks": [{ "id", "text", "status": "pending" }]')
    expect(contract).toContain("Put every diagram in its owning stage")
    expect(contract).toContain('"testReferences": [{ "path", "cases": string[] }]')
    expect(contract).toContain("repository-relative test path")
    expect(contract).toContain("exact named test cases")
    expect(planNote("codex")).toContain(contract)
    expect(planNote("opencode")).toContain(contract)

    const reformat = PLAN_JSON_REFORMAT("- plan.stages.0.tasks: is missing")
    expect(reformat).toContain("TL;DR")
    expect(reformat).toContain("tasks")
    expect(reformat).toContain("owning stage")
    expect(reformat).toContain("testReferences")
  })
})
