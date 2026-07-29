import { describe, expect, it } from "vitest"
import type { PlanPrdStage } from "./plan-document.js"
import { buildPlanExecutionGraph } from "./plan-execution.js"

const stage = (
  id: string,
  options: Partial<PlanPrdStage> = {}
): PlanPrdStage => ({
  id,
  title: `Stage ${id}`,
  intent: "Ship an observable outcome.",
  markdown: "<p>Work.</p>",
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

describe("buildPlanExecutionGraph", () => {
  it("groups dependency-connected stages under one logical assignment in topological order", () => {
    const assignment = {
      agentId: "agent-backend",
      cli: "codex" as const,
      model: "gpt-5",
      reason: "Shared implementation context."
    }
    const result = buildPlanExecutionGraph([
      stage("02", { dependencies: ["01"], complexity: "high", assignment }),
      stage("01", { assignment })
    ], { requireAssignments: true })

    expect(result.valid).toBe(true)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      id: "agent-backend",
      stageIds: ["01", "02"],
      complexity: "high",
      assignment
    })
  })

  it("keeps independent assignments separate and joins exact file overlaps", () => {
    const result = buildPlanExecutionGraph([
      stage("01", {
        markdown: '<ul data-files><li data-change="M">packages/core/src/a.ts</li></ul>'
      }),
      stage("02"),
      stage("03", {
        markdown: '<ul data-files><li data-change="M">packages/core/src/a.ts</li></ul>',
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
      name: "conflicting assignment",
      stages: [
        stage("01"),
        stage("02", { dependencies: ["01"] })
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
})
