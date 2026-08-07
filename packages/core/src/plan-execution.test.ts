import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  type PlanFile,
  type PlanPrd,
  type PlanPrdStage,
  providerReasoningCapabilitiesFor,
  WorkerRoutingConfig,
  workerReasoningSettingIssue
} from "./plan-document.js"
import { WorkspaceConfig } from "./domain.js"
import {
  applyWorkerRouting,
  buildPlanExecutionGraph,
  compileOrchestrationPlan,
  planStructuralDiagnostics,
  resolveWorkerRoutingConfig,
  workerRoutingMismatch
} from "./plan-execution.js"

const files = (...paths: ReadonlyArray<string>): Array<PlanFile> =>
  paths.map((path) => ({ path, change: "M" as const }))

const stage = (
  id: string,
  options: Partial<PlanPrdStage> = {}
): PlanPrdStage => ({
  id,
  title: `Stage ${id}`,
  intent: "Ship an observable outcome.",
  approach: [],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [],
  complexity: "medium",
  dependencies: [],
  assignment: {
    agentId: `agent-${id}`,
    cli: "codex",
    model: "gpt-5",
    reason: "Good fit."
  },
  executionStatus: "queued",
  ...options
})

/** An assignment-free semantic stage, as a planner authors it before routing. */
const semanticStage = (
  id: string,
  options: Partial<PlanPrdStage> = {}
): PlanPrdStage =>
  stage(id, {
    assignment: null,
    acceptance: [{ id: `${id}.1`, text: "It works.", status: "pending", evidence: null }],
    ...options
  })

const plan = (title: string, stages: ReadonlyArray<PlanPrdStage>): PlanPrd => ({
  title,
  sections: [],
  stages: [...stages],
  annotations: []
})

describe("planStructuralDiagnostics", () => {
  it("passes a structurally sound plan (unique ids, resolvable deps)", () => {
    const ok = plan("PRD: ok", [
      semanticStage("01"),
      semanticStage("02", { dependencies: ["01"] })
    ])
    expect(planStructuralDiagnostics(ok)).toEqual([])
  })

  it("flags duplicate stage ids, dangling deps, and duplicate acceptance ids", () => {
    const broken = plan("PRD: broken", [
      semanticStage("01"),
      // duplicate stage id
      semanticStage("01"),
      // depends on a stage that does not exist
      semanticStage("02", { dependencies: ["ghost"] }),
      // reuses acceptance id 01.1 across a distinct stage
      semanticStage("03", {
        acceptance: [{ id: "01.1", text: "Reused.", status: "pending", evidence: null }]
      })
    ])
    const codes = planStructuralDiagnostics(broken).map((d) => d.code)
    expect(codes).toContain("duplicate-stage")
    expect(codes).toContain("dangling-dependency")
    expect(codes).toContain("duplicate-acceptance")
  })

  it("does NOT require acceptance criteria — a draft may still be filling them in", () => {
    const draftish = plan("PRD: draft", [semanticStage("01", { acceptance: [] })])
    expect(planStructuralDiagnostics(draftish)).toEqual([])
  })
})

describe("buildPlanExecutionGraph", () => {
  it("treats a dependency as an ordering edge (dependsOn) across SEPARATE parallel workers", () => {
    // A dependency no longer merges the two stages into one worker — that would
    // serialise the whole DAG. Independent branches get their own worker; the
    // ordering is carried by `dependsOn` for the scheduler to honour.
    const route = { cli: "codex" as const, model: "gpt-5", reason: "Routed." }
    const result = buildPlanExecutionGraph([
      stage("02", { dependencies: ["01"], complexity: "high", assignment: { agentId: "agent-02", ...route } }),
      stage("01", { assignment: { agentId: "agent-01", ...route } })
    ], { requireAssignments: true })

    expect(result.valid).toBe(true)
    expect(result.groups).toHaveLength(2)
    const first = result.groups.find((group) => group.stageIds.includes("01"))!
    const second = result.groups.find((group) => group.stageIds.includes("02"))!
    expect(first.dependsOn).toEqual([])
    expect(second.dependsOn).toEqual([first.id])
    expect(second.complexity).toBe("high")
  })

  it("merges only a cross-file dependency CYCLE onto one worker (keeps the DAG acyclic)", () => {
    // A shares a file with B, C shares a file with D. A depends on D and C depends
    // on B → the {A,B} and {C,D} file-components each depend on the other. They
    // cannot run as ordered separate workers, so they condense onto one.
    const route = { agentId: "agent-01", cli: "codex" as const, model: "gpt-5", reason: "r" }
    const result = buildPlanExecutionGraph([
      stage("A", { files: files("src/ab.ts"), dependencies: ["D"], assignment: route }),
      stage("B", { files: files("src/ab.ts"), assignment: route }),
      stage("C", { files: files("src/cd.ts"), dependencies: ["B"], assignment: route }),
      stage("D", { files: files("src/cd.ts"), assignment: route })
    ], { requireAssignments: true })

    expect(result.valid).toBe(true)
    expect(result.groups).toHaveLength(1)
    expect([...result.groups[0]!.stageIds].sort()).toEqual(["A", "B", "C", "D"])
    expect(result.groups[0]!.dependsOn).toEqual([])
  })

  it("keeps independent assignments separate and joins normalized file overlaps", () => {
    const result = buildPlanExecutionGraph([
      stage("01", { files: files("packages/core/src/a.ts") }),
      stage("02"),
      stage("03", {
        files: [{ path: "./packages/core/src/x/../a.ts", change: "M" }],
        assignment: {
          agentId: "agent-01",
          cli: "codex",
          model: "gpt-5",
          reason: "Overlapping file ownership."
        }
      })
    ])

    expect(result.valid).toBe(true)
    expect(result.groups.map((group) => group.stageIds)).toEqual([["01", "03"], ["02"]])
    expect(result.groups[0]!.files).toEqual(["packages/core/src/a.ts"])
  })

  it("lets stages with no declared files run independently", () => {
    const explicit = buildPlanExecutionGraph([stage("01"), stage("02")])

    expect(explicit.valid).toBe(true)
    expect(explicit.groups.map((group) => group.stageIds)).toEqual([
      ["01"],
      ["02"]
    ])
  })

  it("aggregates overlaps from every declared file", () => {
    const result = buildPlanExecutionGraph([
      stage("01", { files: files("src/first.ts", "src/shared.ts") }),
      stage("02", {
        files: files("src/shared.ts"),
        assignment: stage("01").assignment
      })
    ])

    expect(result.valid).toBe(true)
    expect(result.groups.map((group) => group.stageIds)).toEqual([["01", "02"]])
    expect(result.groups[0]?.files).toEqual(["src/first.ts", "src/shared.ts"])
  })

  it("rejects absolute and repository-escaping file declarations", () => {
    const result = buildPlanExecutionGraph([
      stage("01", { files: files("/tmp/a.ts", "../../outside.ts") })
    ])

    expect(result.valid).toBe(false)
    expect(result.diagnostics.filter((item) => item.code === "invalid-file-path"))
      .toHaveLength(2)
  })

  it.each([
    {
      name: "dangling dependency",
      stages: [stage("01", { dependencies: ["missing"] })],
      code: "dangling-dependency"
    },
    {
      name: "self dependency",
      stages: [stage("01", { dependencies: ["01"] })],
      code: "self-dependency"
    },
    {
      name: "cycle",
      stages: [
        stage("01", { dependencies: ["02"], assignment: null }),
        stage("02", { dependencies: ["01"], assignment: null })
      ],
      code: "dependency-cycle"
    },
    {
      // Two stages that share a file are one worker (edits must serialise); the
      // planner giving them different default agents is the conflict. (A dependency
      // no longer merges workers, so it can no longer cause this.)
      name: "conflicting assignment",
      stages: [
        stage("01", { files: files("src/shared.ts") }),
        stage("02", { files: files("src/shared.ts") })
      ],
      code: "assignment-conflict"
    }
  ])("rejects a $name with an actionable diagnostic", ({ stages, code }) => {
    const result = buildPlanExecutionGraph(stages)
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, message: expect.any(String) })])
    )
  })

  it("can require a visible assignment for every executable stage", () => {
    const result = buildPlanExecutionGraph([stage("01", { assignment: null })], {
      requireAssignments: true
    })
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: "missing-assignment", stageId: "01" })
  })

  it("rejects one logical agent id reused by independent groups", () => {
    const result = buildPlanExecutionGraph([
      stage("01"),
      stage("02", {
        assignment: {
          agentId: "agent-01",
          cli: "codex",
          model: "gpt-5",
          reason: "This must still be a distinct parallel worker."
        }
      })
    ])

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "assignment-conflict",
        stageId: "02",
        message: expect.stringContaining("independent")
      })
    ])
  })

  it.each([
    {
      name: "dependency",
      second: { dependencies: ["01"] }
    },
    {
      name: "file overlap",
      second: { files: files("src/shared.ts") }
    }
  ])("rejects conflicting reasoning across a $name component", ({ second }) => {
    const first = stage("01", {
      files: files("src/shared.ts"),
      assignment: {
        agentId: "agent-shared",
        cli: "codex",
        model: "gpt-5",
        reason: "Shared route.",
        reasoning: { enabled: true, effort: "low" }
      }
    })
    const result = buildPlanExecutionGraph([
      first,
      stage("02", {
        ...second,
        assignment: {
          agentId: "agent-shared",
          cli: "codex",
          model: "gpt-5",
          reason: "Shared route with conflicting strength.",
          reasoning: { enabled: true, effort: "high" }
        }
      })
    ])

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "assignment-conflict"
        })
      ])
    )
  })
})

describe("worker routing", () => {
  it("uses one provider capability contract for effort options and validation", () => {
    expect(providerReasoningCapabilitiesFor("claude")).toStrictEqual({
      explicitToggle: true,
      efforts: ["low", "medium", "high", "xhigh", "max"]
    })
    expect(providerReasoningCapabilitiesFor("codex")).toStrictEqual({
      explicitToggle: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh"]
    })
    expect(providerReasoningCapabilitiesFor("opencode")).toStrictEqual(
      providerReasoningCapabilitiesFor("codex")
    )
    expect(providerReasoningCapabilitiesFor("cursor")).toStrictEqual({
      explicitToggle: false,
      efforts: []
    })
    expect(
      workerReasoningSettingIssue("claude", { enabled: true, effort: "max" })
    ).toBeNull()
    expect(
      workerReasoningSettingIssue("codex", { enabled: true, effort: "max" })
    ).toBe('codex does not support reasoning effort "max"')
    expect(workerReasoningSettingIssue("cursor", { enabled: false })).toBe(
      "Cursor does not support an explicit reasoning setting"
    )
  })

  const laterPageCodexModel = "gpt-5.6-terra"
  const catalog = [
    {
      cli: "claude" as const,
      models: [{ id: "opus" }, { id: "haiku" }]
    },
    {
      cli: "codex" as const,
      models: [{ id: "gpt-5.6-sol" }, { id: laterPageCodexModel }]
    }
  ]
  const configured: WorkerRoutingConfig = {
    default: { cli: "claude", model: "opus" },
    low: { cli: "claude", model: "haiku" },
    medium: { cli: "codex", model: "gpt-5.6-sol" },
    high: { cli: "claude", model: "opus" }
  }
  const reasoningConfigured: WorkerRoutingConfig = {
    default: { cli: "codex", model: "gpt-5.6-sol" },
    low: {
      cli: "claude",
      model: "haiku",
      reasoning: { enabled: true, effort: "low" }
    },
    medium: {
      cli: "codex",
      model: "gpt-5.6-sol",
      reasoning: { enabled: true, effort: "medium" }
    },
    high: {
      cli: "claude",
      model: "opus",
      reasoning: { enabled: true, effort: "high" }
    }
  }

  it("derives distinct automatic routes for low, medium, and high complexity when viable models exist", () => {
    const automatic = resolveWorkerRoutingConfig(undefined, [
      {
        cli: "codex",
        models: [
          { id: "gpt-5.6-sol" },
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-luna" }
        ]
      }
    ])

    expect(automatic).toStrictEqual({
      default: { cli: "codex", model: "gpt-5.6-terra" },
      low: { cli: "codex", model: "gpt-5.6-luna" },
      medium: { cli: "codex", model: "gpt-5.6-terra" },
      high: { cli: "codex", model: "gpt-5.6-sol" }
    })
    if (automatic === null) return

    const compiled = compileOrchestrationPlan(
      plan("Automatic routes", [
        semanticStage("low", { complexity: "low" }),
        semanticStage("medium", { complexity: "medium" }),
        semanticStage("high", { complexity: "high" })
      ]),
      automatic
    )

    expect(compiled.valid).toBe(true)
    if (!compiled.valid) return
    expect(
      compiled.plan.stages.map((item) => item.assignment?.model)
    ).toStrictEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])
  })

  it("preserves available saved worker routes and deterministically replaces unavailable routes", () => {
    const liveCatalog = [
      {
        cli: "opencode" as const,
        models: [{ id: "user/balanced-model" }]
      },
      {
        cli: "codex" as const,
        models: [
          { id: "gpt-5.6-luna" },
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-sol" }
        ]
      },
      {
        cli: "claude" as const,
        models: [{ id: "haiku" }, { id: "sonnet" }, { id: "opus" }]
      }
    ]
    const saved: WorkerRoutingConfig = {
      default: {
        cli: "codex",
        model: "gpt-5.6-terra",
        reasoning: { enabled: true, effort: "high" }
      },
      low: {
        cli: "codex",
        model: "retired-efficient",
        reasoning: { enabled: true, effort: "minimal" }
      },
      medium: {
        cli: "opencode",
        model: "user/balanced-model",
        reasoning: { enabled: true, effort: "xhigh" }
      },
      high: {
        cli: "claude",
        model: "retired-strong",
        reasoning: { enabled: true, effort: "max" }
      }
    }

    const expected: WorkerRoutingConfig = {
      default: saved.default,
      low: { cli: "claude", model: "haiku" },
      medium: saved.medium,
      high: { cli: "claude", model: "opus" }
    }
    expect(resolveWorkerRoutingConfig(saved, liveCatalog)).toStrictEqual(expected)
    expect(
      resolveWorkerRoutingConfig(saved, [...liveCatalog].reverse())
    ).toStrictEqual(expected)
  })

  it("collapses automatic tiers safely when only one model is available", () => {
    expect(
      resolveWorkerRoutingConfig(undefined, [
        { cli: "codex", models: [{ id: "gpt-5.6-sol" }] }
      ])
    ).toEqual({
      default: { cli: "codex", model: "gpt-5.6-sol" },
      low: { cli: "codex", model: "gpt-5.6-sol" },
      medium: { cli: "codex", model: "gpt-5.6-sol" },
      high: { cli: "codex", model: "gpt-5.6-sol" }
    })
  })

  it("decodes legacy routes as provider-default reasoning", () => {
    const decoded = Schema.decodeUnknownEither(WorkerRoutingConfig)(configured)

    expect(Either.isRight(decoded)).toBe(true)
    if (!Either.isRight(decoded)) return
    expect(resolveWorkerRoutingConfig(decoded.right, catalog)).toStrictEqual(
      configured
    )
    expect(decoded.right.medium.reasoning).toBeUndefined()
  })

  it("round-trips reasoning settings through workspace configuration", () => {
    const persisted = JSON.parse(
      JSON.stringify({
        reposDir: null,
        createdAt: "2026-07-31T12:00:00.000Z",
        workerRouting: reasoningConfigured
      })
    )
    const decoded = Schema.decodeUnknownEither(WorkspaceConfig)(persisted)

    expect(Either.isRight(decoded)).toBe(true)
    if (!Either.isRight(decoded)) return
    expect(decoded.right.workerRouting).toStrictEqual(reasoningConfigured)
  })

  it.each([
    ["Claude minimal", { cli: "claude", model: "opus", reasoning: { enabled: true, effort: "minimal" } }],
    ["Codex max", { cli: "codex", model: "gpt-5.6-sol", reasoning: { enabled: true, effort: "max" } }],
    ["Cursor explicit reasoning", { cli: "cursor", model: "auto", reasoning: { enabled: true, effort: "low" } }],
    ["disabled with an effort", { cli: "codex", model: "gpt-5.6-sol", reasoning: { enabled: false, effort: "high" } }]
  ])("rejects provider-incompatible %s routes", (_name, route) => {
    expect(Either.isLeft(Schema.decodeUnknownEither(WorkerRoutingConfig)({
      default: configured.default,
      low: route,
      medium: configured.medium,
      high: configured.high
    }))).toBe(true)
  })

  it("routes dep-linked stages as SEPARATE workers, each by its own complexity", () => {
    const stages = [
      stage("01", {
        title: "Inspect",
        complexity: "low",
        files: files("src/auth.ts"),
        assignment: {
          agentId: "worker-auth",
          cli: "codex",
          model: "gpt-5.6-sol",
          reason: "Planner choice",
          reasoning: { enabled: true, effort: "high" }
        }
      }),
      stage("02", {
        title: "Implement",
        dependencies: ["01"],
        complexity: "high",
        assignment: {
          agentId: "worker-auth",
          cli: "codex",
          model: "gpt-5.6-sol",
          reason: "Planner choice",
          reasoning: { enabled: true, effort: "high" }
        }
      }),
      stage("03", { title: "Release", complexity: "medium", assignment: null })
    ]

    const routed = applyWorkerRouting(stages, configured)

    expect(routed.map((item) => item.assignment)).toMatchObject([
      // 01 (low) and 02 (high) are independent workers now, each routed by its own
      // complexity, rather than merged under one high-complexity worker.
      { agentId: "worker-auth", cli: "claude", model: "haiku" },
      { agentId: "worker-auth-2", cli: "claude", model: "opus" },
      { agentId: "agent-03", cli: "codex", model: "gpt-5.6-sol" }
    ])
    expect(routed.every((item) => item.assignment?.reasoning === undefined)).toBe(true)
    expect(workerRoutingMismatch(routed, configured)).toBeNull()
  })

  it("compiles assignment-free plan semantics into one routed worker per component", () => {
    const source = plan("Compile workers", [
      semanticStage("01", { title: "Inspect", complexity: "low", files: files("src/shared.ts") }),
      semanticStage("02", {
        title: "Implement",
        dependencies: ["01"],
        complexity: "high"
      }),
      semanticStage("03", { title: "Document", complexity: "low", files: files("docs/change.md") })
    ])

    const compiled = compileOrchestrationPlan(source, reasoningConfigured)

    expect(compiled.valid).toBe(true)
    if (!compiled.valid) return
    expect(compiled.graph.valid).toBe(true)
    // Each stage is its own parallel worker now (deps order, they don't merge).
    expect(compiled.plan.stages.map((item) => item.assignment)).toMatchObject([
      {
        agentId: "agent-01",
        cli: "claude",
        model: "haiku",
        reasoning: { enabled: true, effort: "low" }
      },
      {
        agentId: "agent-02",
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "high" }
      },
      {
        agentId: "agent-03",
        cli: "claude",
        model: "haiku",
        reasoning: { enabled: true, effort: "low" }
      }
    ])
  })

  it("preserves an existing component identity and allocates a new independent worker", () => {
    const original = compileOrchestrationPlan(
      plan("Stable workers", [
        semanticStage("01", { title: "Existing", complexity: "medium", files: files("src/existing.ts") })
      ]),
      configured
    )
    expect(original.valid).toBe(true)
    if (!original.valid) return

    const amendment = compileOrchestrationPlan(
      plan("Stable workers", [
        semanticStage("01", { title: "Existing", complexity: "medium", files: files("src/existing.ts") }),
        semanticStage("02", { title: "Independent", complexity: "high", files: files("src/independent.ts") }),
        semanticStage("03", {
          title: "Dependent",
          dependencies: ["01"],
          complexity: "low",
          files: files("src/dependent.ts")
        })
      ]),
      configured,
      { previousStages: original.plan.stages }
    )

    expect(amendment.valid).toBe(true)
    if (!amendment.valid) return
    // The dependent stage is its own parallel worker (agent-03), not merged back
    // onto its prerequisite's worker; the existing worker keeps its id.
    expect(amendment.plan.stages.map((item) => item.assignment?.agentId)).toStrictEqual([
      "agent-01",
      "agent-02",
      "agent-03"
    ])
    expect(amendment.plan.stages[1]?.executionStatus).toBe("queued")
  })

  it("applies the exact configured Codex model id to the routed assignment", () => {
    const routing: WorkerRoutingConfig = {
      ...configured,
      medium: { cli: "codex", model: laterPageCodexModel }
    }
    const routed = applyWorkerRouting(
      [stage("01", { title: "Ship", complexity: "medium", files: files("src/ship.ts") })],
      routing
    )

    expect(routed[0]?.assignment).toMatchObject({
      cli: "codex",
      model: laterPageCodexModel
    })
  })

  it("applies every complexity bucket's complete reasoning route", () => {
    const routed = applyWorkerRouting(
      [
        stage("01", { title: "Low", complexity: "low", assignment: null }),
        stage("02", { title: "Medium", complexity: "medium", assignment: null }),
        stage("03", { title: "High", complexity: "high", assignment: null })
      ],
      reasoningConfigured
    )

    expect(routed.map((item) => item.assignment?.reasoning)).toStrictEqual([
      { enabled: true, effort: "low" },
      { enabled: true, effort: "medium" },
      { enabled: true, effort: "high" }
    ])
    expect(workerRoutingMismatch(routed, reasoningConfigured)).toBeNull()

    const medium = routed[1]
    const mediumAssignment = medium?.assignment
    if (medium === undefined || mediumAssignment === null || mediumAssignment === undefined) {
      return
    }
    const mismatched = routed.map((item) =>
      item.id === medium.id
        ? {
            ...item,
            assignment: {
              ...mediumAssignment,
              reasoning: reasoningConfigured.high.reasoning
            }
          }
        : item
    )
    expect(workerRoutingMismatch(mismatched, reasoningConfigured)?.stageIds)
      .toContain("02")
  })
})
