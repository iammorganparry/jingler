import { describe, expect, it } from "vitest"
import type { PlanPrd } from "@jingler/core"
import { parseOrchestratorAmendment, stripOrchestratorAmendment } from "./orchestrator-amend.js"

/**
 * The orchestrator amends its approved plan by re-issuing the whole plan as a
 * ` ```json ` emission block in an auto-mode reply. These cover the "is this an
 * amendment?" decision — a plan block with a stage is one; prose, or a plan with
 * no stage, is not — and that the block is scrubbed from what the operator reads.
 */

const plan = (title: string, stages: PlanPrd["stages"]): PlanPrd => ({
  title,
  sections: [],
  stages,
  annotations: []
})

const stage = (id: string) => ({
  id,
  title: `Stage ${id}`,
  intent: "Do it.",
  approach: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{ id: `${id}.1`, text: "a", status: "pending" as const, evidence: null }],
  dependencies: []
})

const emission = (p: PlanPrd, mode: "draft" | "submit" = "submit"): string =>
  ["```json", JSON.stringify({ mode, plan: p }), "```"].join("\n")

const oneStage = emission(plan("PRD: x", [stage("01")]))

describe("parseOrchestratorAmendment", () => {
  it("returns the plan when the reply carries a plan block with a stage", () => {
    const amendment = parseOrchestratorAmendment(`Folding that in.\n\n${oneStage}`)
    expect(amendment).not.toBeNull()
    expect(amendment?.stages[0]?.id).toBe("01")
  })

  it("returns null for an ordinary reply with no plan block", () => {
    expect(parseOrchestratorAmendment("The build passed. Anything else?")).toBeNull()
  })

  it("returns null for a plan block that declares no stage (an illustration)", () => {
    expect(parseOrchestratorAmendment(emission(plan("PRD: x", [])))).toBeNull()
  })

  it("returns null for a JSON block that is not a plan emission", () => {
    const example = ["```json", JSON.stringify({ some: "other data" }), "```"].join("\n")
    expect(parseOrchestratorAmendment(example)).toBeNull()
  })
})

describe("stripOrchestratorAmendment", () => {
  it("removes the plan block, leaving the human-readable reply", () => {
    const reply = stripOrchestratorAmendment(`Folding that in.\n\n${oneStage}`)
    expect(reply).toBe("Folding that in.")
    expect(reply).not.toContain('"stages"')
  })

  it("leaves a reply with no block untouched", () => {
    expect(stripOrchestratorAmendment("Done — PR opened.")).toBe("Done — PR opened.")
  })

  it("preserves a later block that was not selected as the amendment", () => {
    const example = emission(plan("PRD: Documentation example", [stage("example")]))
    const reply = stripOrchestratorAmendment(
      `Folding that in.\n\n${oneStage}\n\nUseful example:\n\n${example}`
    )

    expect(reply).toContain("Useful example:")
    expect(reply).toContain("PRD: Documentation example")
    expect(reply).not.toContain("PRD: x")
  })
})
