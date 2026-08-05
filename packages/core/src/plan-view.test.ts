import { describe, expect, it } from "vitest"
import type { PlanPrd, PlanPrdSection, PlanPrdStage } from "./plan-document.js"
import {
  stagesToGraph,
  toPlanArchitectureView,
  toPlanStepViews,
  toPlanView
} from "./plan-view.js"

const stage = (
  id: string,
  dependencies: ReadonlyArray<string>,
  overrides: Partial<PlanPrdStage> = {}
): PlanPrdStage => ({
  id,
  title: `Stage ${id}`,
  intent: `Intent ${id}`,
  approach: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [],
  dependencies: [...dependencies],
  ...overrides
})

const prd = (
  stages: ReadonlyArray<PlanPrdStage>,
  sections: ReadonlyArray<PlanPrdSection> = []
): PlanPrd => ({
  title: "PRD: Test",
  sections: [...sections],
  stages: [...stages],
  annotations: []
})

const ids = (values: ReadonlyArray<{ readonly id: string }>): Array<string> =>
  values.map((value) => value.id)

const edgeKeys = (
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
): Array<string> => edges.map((edge) => `${edge.from}->${edge.to}`).sort()

describe("toPlanStepViews", () => {
  it("returns no steps for an empty plan", () => {
    expect(toPlanStepViews(prd([]))).toEqual([])
  })

  it("orders a linear dependency chain topologically", () => {
    // Deliberately out of order in source to prove ordering is by dependency.
    const steps = toPlanStepViews(
      prd([stage("c", ["b"]), stage("a", []), stage("b", ["a"])])
    )
    expect(ids(steps)).toEqual(["a", "b", "c"])
  })

  it("defaults executionStatus to queued and passes complexity through", () => {
    const [queued, running] = toPlanStepViews(
      prd([
        stage("a", []),
        stage("b", ["a"], { complexity: "high", executionStatus: "running" })
      ])
    )
    expect(queued?.executionStatus).toBe("queued")
    expect(queued?.complexity).toBeUndefined()
    expect(running?.executionStatus).toBe("running")
    expect(running?.complexity).toBe("high")
  })

  it("passes a stage's structured file list through", () => {
    const [step] = toPlanStepViews(
      prd([
        stage("a", [], {
          files: [
            { path: "src/foo.ts", change: "A", added: 10, removed: 2 },
            { path: "src/bar.ts", change: "D", added: 0, removed: 5 }
          ]
        })
      ])
    )
    expect(step?.files).toEqual([
      { path: "src/foo.ts", change: "A", added: 10, removed: 2 },
      { path: "src/bar.ts", change: "D", added: 0, removed: 5 }
    ])
  })

  it("yields an empty file list when a stage declares none", () => {
    const [step] = toPlanStepViews(prd([stage("a", [])]))
    expect(step?.files).toEqual([])
  })
})

describe("stagesToGraph", () => {
  it("returns empty nodes and edges for an empty plan", () => {
    expect(stagesToGraph(prd([]))).toEqual({ nodes: [], edges: [] })
  })

  it("builds nodes and edges for a linear chain", () => {
    const graph = stagesToGraph(prd([stage("a", []), stage("b", ["a"]), stage("c", ["b"])]))
    expect(ids(graph.nodes)).toEqual(["a", "b", "c"])
    expect(graph.nodes[0]).toMatchObject({ id: "a", stageId: "a", title: "Stage a" })
    expect(edgeKeys(graph.edges)).toEqual(["a->b", "b->c"])
  })

  it("builds the correct edges and topological node order for a diamond graph", () => {
    // a -> b, a -> c, b -> d, c -> d
    const graph = stagesToGraph(
      prd([stage("a", []), stage("b", ["a"]), stage("c", ["a"]), stage("d", ["b", "c"])])
    )
    expect(ids(graph.nodes)).toEqual(["a", "b", "c", "d"])
    expect(edgeKeys(graph.edges)).toEqual(["a->b", "a->c", "b->d", "c->d"])
  })

  it("drops edges to a dangling dependency id without throwing", () => {
    const graph = stagesToGraph(
      prd([stage("a", []), stage("b", ["a", "does-not-exist"])])
    )
    expect(ids(graph.nodes)).toEqual(["a", "b"])
    expect(edgeKeys(graph.edges)).toEqual(["a->b"])
  })

  it("ignores a self-referential dependency", () => {
    const graph = stagesToGraph(prd([stage("a", ["a"])]))
    expect(graph.edges).toEqual([])
  })

  it("carries the assigned worker's agentId and a cli · model label", () => {
    const graph = stagesToGraph(
      prd([
        stage("a", [], {
          executionStatus: "running",
          assignment: {
            agentId: "worker-a",
            cli: "codex",
            model: "gpt-5.6-sol",
            reason: "High complexity route."
          }
        }),
        stage("b", ["a"])
      ])
    )
    const a = graph.nodes.find((node) => node.id === "a")
    const b = graph.nodes.find((node) => node.id === "b")
    expect(a?.agentId).toBe("worker-a")
    expect(a?.worker).toBe("codex · gpt-5.6-sol")
    // A stage with no assignment carries nulls, not undefined.
    expect(b?.agentId).toBeNull()
    expect(b?.worker).toBeNull()
  })
})

describe("toPlanArchitectureView", () => {
  it("returns empty sections and stages for an empty plan", () => {
    expect(toPlanArchitectureView(prd([]))).toEqual({ sections: [], stages: [] })
  })

  it("keeps section diagrams in their section and stage diagrams in their stage", () => {
    const sections: Array<PlanPrdSection> = [
      {
        id: "context",
        title: "Context",
        blocks: [
          { kind: "prose", id: "p1", text: "One document is authoritative." },
          { kind: "diagram", id: "d1", source: "graph TD; A-->B" }
        ]
      }
    ]
    const stages = [
      stage("a", [], {
        diagrams: [{ id: "sd1", source: "flowchart LR; X-->Y" }]
      })
    ]
    const view = toPlanArchitectureView(prd(stages, sections))
    expect(view.sections.map((section) => section.title)).toEqual(["Context"])
    expect(view.sections[0]?.blocks[1]).toEqual({
      kind: "diagram",
      id: "d1",
      source: "graph TD; A-->B"
    })
    expect(view.stages).toEqual([
      {
        id: "a",
        title: "Stage a",
        diagrams: [{ id: "sd1", source: "flowchart LR; X-->Y" }]
      }
    ])
  })

  it("keeps every architecture diagram associated with its owning stage", () => {
    const view = toPlanArchitectureView(
      prd([
        stage("a", [], {
          diagrams: [
            { id: "a-flow", source: "flowchart LR; Input-->Core" },
            { id: "a-state", source: "stateDiagram-v2; [*]-->Ready" }
          ]
        }),
        stage("b", ["a"], {
          diagrams: [{ id: "b-flow", source: "flowchart LR; Core-->UI" }]
        })
      ])
    )

    expect(view.stages).toEqual([
      {
        id: "a",
        title: "Stage a",
        diagrams: [
          { id: "a-flow", source: "flowchart LR; Input-->Core" },
          { id: "a-state", source: "stateDiagram-v2; [*]-->Ready" }
        ]
      },
      {
        id: "b",
        title: "Stage b",
        diagrams: [{ id: "b-flow", source: "flowchart LR; Core-->UI" }]
      }
    ])
  })
})

describe("toPlanView", () => {
  it("bundles steps, architecture, and workflow projections", () => {
    const view = toPlanView(
      prd(
        [stage("a", []), stage("b", ["a"])],
        [
          {
            id: "context",
            title: "Context",
            blocks: [{ kind: "prose", id: "p1", text: "Prose." }]
          }
        ]
      )
    )
    expect(ids(view.steps)).toEqual(["a", "b"])
    expect(view.architecture.sections.map((section) => section.title)).toEqual(["Context"])
    expect(ids(view.workflow.nodes)).toEqual(["a", "b"])
    expect(edgeKeys(view.workflow.edges)).toEqual(["a->b"])
  })
})
