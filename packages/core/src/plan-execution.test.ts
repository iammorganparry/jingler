import { describe, expect, it } from "vitest"
import type {
  PlanPrdStage,
  WorkerRoutingConfig
} from "./plan-document.js"
import {
  applyWorkerRoutingToPlanHtml,
  buildPlanExecutionGraph,
  resolveWorkerRoutingConfig,
  workerRoutingMismatch
} from "./plan-execution.js"
import { parsePlanHtml } from "./plan-html.js"

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

  it("keeps independent assignments separate and joins normalized file overlaps", () => {
    const result = buildPlanExecutionGraph([
      stage("01", {
        markdown: '<ul data-files><li data-change="M">packages/core/src/a.ts</li></ul>'
      }),
      stage("02"),
      stage("03", {
        markdown: '<ul data-files><li data-change="M">./packages/core/src/x/../a.ts</li></ul>',
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

  it("rejects absolute and repository-escaping file declarations", () => {
    const result = buildPlanExecutionGraph([
      stage("01", {
        markdown:
          '<ul data-files><li>/tmp/a.ts</li><li>../../outside.ts</li></ul>'
      })
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

describe("worker routing", () => {
  const catalog = [
    {
      cli: "claude" as const,
      models: [{ id: "opus" }, { id: "haiku" }]
    },
    {
      cli: "codex" as const,
      models: [{ id: "gpt-5.6-sol" }]
    }
  ]
  const configured: WorkerRoutingConfig = {
    default: { cli: "claude", model: "opus" },
    low: { cli: "claude", model: "haiku" },
    medium: { cli: "codex", model: "gpt-5.6-sol" },
    high: { cli: "claude", model: "opus" }
  }

  it("uses a capability-first default and falls unavailable buckets back to it", () => {
    expect(resolveWorkerRoutingConfig(undefined, catalog)).toEqual({
      default: { cli: "claude", model: "opus" },
      low: { cli: "claude", model: "opus" },
      medium: { cli: "claude", model: "opus" },
      high: { cli: "claude", model: "opus" }
    })
    expect(
      resolveWorkerRoutingConfig(
        {
          ...configured,
          low: { cli: "codex", model: "retired" }
        },
        catalog
      )?.low
    ).toEqual({ cli: "claude", model: "opus" })
  })

  it("normalizes each dependency/file component to its strongest complexity route", () => {
    const source = `<h1>PRD: Route work</h1>
<section data-stage="01" data-title="Inspect" data-complexity="low">
<div data-assignment data-agent-id="worker-auth" data-cli="codex" data-model="gpt-5.6-sol" data-reason="Planner choice" data-status="queued"></div>
<ul data-files><li>src/auth.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">The path is understood.</div>
</section>
<section data-stage="02" data-title="Implement" data-depends-on="01" data-complexity="high">
<div data-assignment data-agent-id="worker-auth" data-cli="codex" data-model="gpt-5.6-sol" data-reason="Planner choice" data-status="queued"></div>
<div data-acceptance="02.1" data-status="pending">The change works.</div>
</section>
<section data-stage="03" data-title="Release" data-complexity="medium">
<div data-acceptance="03.1" data-status="pending">The release is ready.</div>
</section>`
    const parsed = parsePlanHtml(source)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return

    const normalized = parsePlanHtml(
      applyWorkerRoutingToPlanHtml(
        parsed.html,
        parsed.projection.stages,
        configured
      )
    )
    expect(normalized.valid).toBe(true)
    if (!normalized.valid) return
    expect(
      normalized.projection.stages.map((item) => item.assignment)
    ).toMatchObject([
      { agentId: "worker-auth", cli: "claude", model: "opus" },
      { agentId: "worker-auth", cli: "claude", model: "opus" },
      { agentId: "agent-02", cli: "codex", model: "gpt-5.6-sol" }
    ])
    expect(
      workerRoutingMismatch(normalized.projection.stages, configured)
    ).toBeNull()
  })
})
