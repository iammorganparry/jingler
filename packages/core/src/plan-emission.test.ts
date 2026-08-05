import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodePlanEmission,
  formatPlanEmissionDiagnostics,
  PlanDelta
} from "./plan-emission.js"
import { type PlanPrd, planTextProjection } from "./plan-document.js"

const validPlan: PlanPrd = {
  title: "PRD: Make onboarding fast",
  sections: [
    {
      id: "context",
      title: "Context",
      blocks: [{ kind: "prose", id: "p1", text: "The generated output is already correct." }]
    }
  ],
  stages: [
    {
      id: "01",
      title: "Add observability",
      intent: "Measure latency.",
      approach: ["Wrap the model call"],
      files: [{ path: "src/model.ts", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "An event is emitted.", status: "pending", evidence: null }]
    }
  ],
  annotations: []
}

describe("decodePlanEmission", () => {
  it("decodes a well-formed submit emission", () => {
    const result = decodePlanEmission(JSON.stringify({ mode: "submit", plan: validPlan }))
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.emission.mode).toBe("submit")
    expect(result.emission.plan.stages[0]?.id).toBe("01")
  })

  it("decodes a draft emission", () => {
    const result = decodePlanEmission(JSON.stringify({ mode: "draft", plan: validPlan }))
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.emission.mode).toBe("draft")
  })

  // The exact failure that shipped the bug: a structurally-off plan must produce
  // typed, fixable diagnostics — never a silent drop that leaves Plan Review empty.
  it("returns typed diagnostics for a plan missing a required field", () => {
    const { title: _title, ...noTitle } = validPlan
    const result = decodePlanEmission(JSON.stringify({ mode: "submit", plan: noTitle }))
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics.some((d) => d.path.includes("title"))).toBe(true)
    expect(formatPlanEmissionDiagnostics(result.diagnostics)).toContain("title")
  })

  it("rejects an unknown mode", () => {
    const result = decodePlanEmission(JSON.stringify({ mode: "delegate", plan: validPlan }))
    expect(result.valid).toBe(false)
  })

  it("rejects an unknown block kind", () => {
    const bad = {
      ...validPlan,
      sections: [{ id: "s", title: "S", blocks: [{ kind: "widget", id: "w", text: "x" }] }]
    }
    const result = decodePlanEmission(JSON.stringify({ mode: "draft", plan: bad }))
    expect(result.valid).toBe(false)
  })

  it("reports non-JSON input as a diagnostic rather than throwing", () => {
    const result = decodePlanEmission("{ not json")
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics[0]?.message).toContain("JSON")
  })
})

describe("PlanDelta", () => {
  it("decodes a granular task status delta", () => {
    const delta = Schema.decodeUnknownSync(PlanDelta)({
      _tag: "SetTaskStatus",
      stageId: "01",
      taskId: "01.task.2",
      status: "in-progress"
    })

    expect(delta).toEqual({
      _tag: "SetTaskStatus",
      stageId: "01",
      taskId: "01.task.2",
      status: "in-progress"
    })
  })
})

describe("planTextProjection", () => {
  it("concatenates title, section, and stage text deterministically", () => {
    const text = planTextProjection(validPlan)
    expect(text).toContain("PRD: Make onboarding fast")
    expect(text).toContain("The generated output is already correct.")
    expect(text).toContain("Add observability")
    expect(text).toContain("An event is emitted.")
    // Deterministic: same input, same output.
    expect(planTextProjection(validPlan)).toBe(text)
  })
})
