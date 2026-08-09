import { describe, expect, it } from "vitest"
import type { PlanPrd, PlanPrdStage } from "./plan-document.js"
import { planStageSemanticFingerprint, reconcilePlanAmendment } from "./plan-reconciliation.js"

const stage = (overrides: Partial<PlanPrdStage> = {}): PlanPrdStage => ({
  id: "01",
  title: "Implement",
  intent: "Ship the change.",
  approach: ["Use the existing boundary."],
  tasks: [{ id: "01.1", text: "Implement it", status: "pending" }],
  files: [{ path: "src/feature.ts", change: "M" }],
  diagrams: [],
  notes: [],
  acceptance: [{
    id: "01.A",
    text: "The feature works.",
    testReferences: [{ path: "src/feature.test.ts", cases: ["works"] }],
    status: "pending",
    evidence: null
  }],
  dependencies: [],
  complexity: "medium",
  ...overrides
})

const plan = (stages: ReadonlyArray<PlanPrdStage>): PlanPrd => ({
  title: "Plan",
  sections: [],
  stages: [...stages],
  annotations: []
})

describe("reconcilePlanAmendment", () => {
  it("preserves task progress and evidence for unchanged stage semantics", () => {
    const previous = stage({
      tasks: [{ id: "01.1", text: "Implement it", status: "completed" }],
      acceptance: [{
        id: "01.A",
        text: "The feature works.",
        testReferences: [{ path: "src/feature.test.ts", cases: ["works"] }],
        status: "passed",
        evidence: "Focused test passed."
      }]
    })
    const result = reconcilePlanAmendment(plan([previous]), plan([stage()]))
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.changedStageIds).toEqual([])
    expect(result.plan.stages[0]?.tasks?.[0]?.status).toBe("completed")
    expect(result.plan.stages[0]?.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: "Focused test passed."
    })
  })

  it("resets progress when the producing agent changes stage semantics", () => {
    const previous = stage({
      tasks: [{ id: "01.1", text: "Implement it", status: "completed" }],
      acceptance: [{
        id: "01.A",
        text: "The feature works.",
        testReferences: [],
        status: "passed",
        evidence: "Old evidence."
      }]
    })
    const replacement = stage({ intent: "Ship the revised change." })
    const result = reconcilePlanAmendment(plan([previous]), plan([replacement]))
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.changedStageIds).toEqual(["01"])
    expect(result.plan.stages[0]?.tasks?.[0]?.status).toBe("completed")
    expect(result.plan.stages[0]?.acceptance[0]).toMatchObject({ status: "pending", evidence: null })
  })

  it("treats task status and criterion evidence as non-semantic", () => {
    const a = stage()
    const b = stage({
      tasks: [{ id: "01.1", text: "Implement it", status: "completed" }],
      acceptance: [{
        id: "01.A",
        text: "The feature works.",
        testReferences: [{ path: "src/feature.test.ts", cases: ["works"] }],
        status: "passed",
        evidence: "passed"
      }]
    })
    expect(planStageSemanticFingerprint(a)).toBe(planStageSemanticFingerprint(b))
  })
})
