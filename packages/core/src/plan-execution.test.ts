import { describe, expect, it } from "vitest"
import type { PlanPrd, PlanPrdStage } from "./plan-document.js"
import { buildPlanExecutionGraph, planStructuralDiagnostics } from "./plan-execution.js"

const stage = (id: string, dependencies: ReadonlyArray<string> = []): PlanPrdStage => ({
  id,
  title: `Stage ${id}`,
  intent: "Ship an observable outcome.",
  approach: [],
  tasks: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{ id: `${id}.1`, text: "It works.", testReferences: [], status: "pending", evidence: null }],
  dependencies,
  complexity: "medium"
})

const plan = (stages: ReadonlyArray<PlanPrdStage>): PlanPrd => ({
  title: "Plan",
  sections: [],
  stages: [...stages],
  annotations: []
})

describe("buildPlanExecutionGraph", () => {
  it("orders dependency-connected stages topologically without worker routing", () => {
    const graph = buildPlanExecutionGraph([stage("02", ["01"]), stage("01"), stage("03")])
    expect(graph.valid).toBe(true)
    expect(graph.groups.map((group) => group.stageIds)).toEqual([["01", "02"], ["03"]])
  })

  it("deduplicates dependencies and files while preserving topological ties and maximum complexity", () => {
    const file = { path: "src/shared.ts", change: "M" as const }
    const graph = buildPlanExecutionGraph([
      { ...stage("child", ["root", "root"]), files: [file], complexity: "low" as const },
      { ...stage("sibling", ["root"]), files: [file], complexity: "high" as const },
      stage("root"),
      stage("isolated")
    ])
    expect(graph.diagnostics).toEqual([])
    expect(graph.groups).toEqual([
      { id: "root", stageIds: ["root", "child", "sibling"], complexity: "high", files: [file] },
      { id: "isolated", stageIds: ["isolated"], complexity: "medium", files: [] }
    ])
  })

  it("reports self dependencies without creating a cycle or joining unrelated groups", () => {
    const graph = buildPlanExecutionGraph([stage("self", ["self", "absent"]), stage("other")])
    expect(graph.diagnostics.map(({ code }) => code)).toEqual(["self-dependency", "dangling-dependency"])
    expect(graph.groups.map(({ stageIds }) => stageIds)).toEqual([["self"], ["other"]])
  })

  it("reports cycles and retains every stage in the view order", () => {
    const graph = buildPlanExecutionGraph([stage("01", ["02"]), stage("02", ["01"])])
    expect(graph.valid).toBe(false)
    expect(graph.diagnostics.map((item) => item.code)).toContain("dependency-cycle")
    expect(graph.groups.flatMap((group) => group.stageIds)).toEqual(["01", "02"])
  })
})

describe("planStructuralDiagnostics", () => {
  it("flags duplicate ids, dangling dependencies, and non-relative file paths", () => {
    const duplicate = stage("01")
    const broken = stage("01", ["missing"])
    const withPath = { ...broken, files: [{ path: "../outside.ts", change: "M" as const }] }
    const codes = planStructuralDiagnostics(plan([duplicate, withPath])).map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining([
      "duplicate-stage",
      "dangling-dependency",
      "invalid-file-path",
      "duplicate-acceptance"
    ]))
  })
})
