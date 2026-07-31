import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type {
  PlanPrdStage
} from "./plan-document.js"
import { WorkerRoutingConfig } from "./plan-document.js"
import { WorkspaceConfig } from "./domain.js"
import {
  applyWorkerRoutingToPlanHtml,
  buildPlanExecutionGraph,
  compileOrchestrationPlanHtml,
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
  markdown: "<p>Work.</p><ul data-files></ul>",
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

  it("serializes undeclared stages while allowing explicit no-file stages to run independently", () => {
    const sharedAssignment = stage("01").assignment
    const conservative = buildPlanExecutionGraph([
      stage("01", { markdown: "<p>Undeclared work.</p>" }),
      stage("02", {
        markdown: "<p>Also undeclared.</p>",
        assignment: sharedAssignment
      })
    ])
    const explicit = buildPlanExecutionGraph([stage("01"), stage("02")])

    expect(conservative.valid).toBe(true)
    expect(conservative.groups.map((group) => group.stageIds)).toEqual([
      ["01", "02"]
    ])
    expect(explicit.valid).toBe(true)
    expect(explicit.groups.map((group) => group.stageIds)).toEqual([
      ["01"],
      ["02"]
    ])
  })

  it("aggregates overlaps from every declared file list", () => {
    const result = buildPlanExecutionGraph([
      stage("01", {
        markdown:
          "<ul data-files><li>src/first.ts</li></ul>" +
          "<ul data-files><li>src/shared.ts</li></ul>"
      }),
      stage("02", {
        markdown: "<ul data-files><li>src/shared.ts</li></ul>",
        assignment: stage("01").assignment
      })
    ])

    expect(result.valid).toBe(true)
    expect(result.groups.map((group) => group.stageIds)).toEqual([["01", "02"]])
    expect(result.groups[0]?.files).toEqual(["src/first.ts", "src/shared.ts"])
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

  it.each([
    {
      name: "dependency",
      second: { dependencies: ["01"] }
    },
    {
      name: "file overlap",
      second: {
        markdown: "<ul data-files><li>src/shared.ts</li></ul>"
      }
    }
  ])("rejects conflicting reasoning across a $name component", ({ second }) => {
    const first = stage("01", {
      markdown: "<ul data-files><li>src/shared.ts</li></ul>",
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

  it("normalizes each dependency/file component to its strongest complexity route", () => {
    const source = `<h1>PRD: Route work</h1>
<section data-stage="01" data-title="Inspect" data-complexity="low">
<div data-assignment data-agent-id="worker-auth" data-cli="codex" data-model="gpt-5.6-sol" data-thinking-enabled="true" data-reasoning-effort="high" data-reason="Planner choice" data-status="queued"></div>
<ul data-files><li>src/auth.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">The path is understood.</div>
</section>
<section data-stage="02" data-title="Implement" data-depends-on="01" data-complexity="high">
<div data-assignment data-agent-id="worker-auth" data-cli="codex" data-model="gpt-5.6-sol" data-thinking-enabled="true" data-reasoning-effort="high" data-reason="Planner choice" data-status="queued"></div>
<ul data-files></ul>
<div data-acceptance="02.1" data-status="pending">The change works.</div>
</section>
<section data-stage="03" data-title="Release" data-complexity="medium">
<ul data-files></ul>
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
      normalized.projection.stages.every(
        (item) => item.assignment?.reasoning === undefined
      )
    ).toBe(true)
    expect(normalized.html).not.toContain("data-thinking-enabled")
    expect(normalized.html).not.toContain("data-reasoning-effort")
    expect(
      workerRoutingMismatch(normalized.projection.stages, configured)
    ).toBeNull()
  })

  it("compiles assignment-free plan semantics into one routed worker per component", () => {
    const source = `<h1>PRD: Compile workers</h1>
<section data-stage="01" data-title="Inspect" data-complexity="low">
<ul data-files><li>src/shared.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">Inspection is complete.</div>
</section>
<section data-stage="02" data-title="Implement" data-depends-on="01" data-complexity="high">
<ul data-files></ul>
<div data-acceptance="02.1" data-status="pending">Implementation works.</div>
</section>
<section data-stage="03" data-title="Document" data-complexity="low">
<ul data-files><li>docs/change.md</li></ul>
<div data-acceptance="03.1" data-status="pending">Documentation is accurate.</div>
</section>`

    const compiled = compileOrchestrationPlanHtml(
      source,
      reasoningConfigured
    )

    expect(compiled.valid).toBe(true)
    if (!compiled.valid) return
    expect(compiled.graph.valid).toBe(true)
    expect(
      compiled.projection.stages.map((item) => item.assignment)
    ).toMatchObject([
      {
        agentId: "agent-01",
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "high" }
      },
      {
        agentId: "agent-01",
        cli: "claude",
        model: "opus",
        reasoning: { enabled: true, effort: "high" }
      },
      {
        agentId: "agent-02",
        cli: "claude",
        model: "haiku",
        reasoning: { enabled: true, effort: "low" }
      }
    ])
  })

  it("preserves an existing component identity and allocates a new independent worker", () => {
    const original = compileOrchestrationPlanHtml(
      `<h1>PRD: Stable workers</h1>
<section data-stage="01" data-title="Existing" data-complexity="medium">
<ul data-files><li>src/existing.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">Existing work succeeds.</div>
</section>`,
      configured
    )
    expect(original.valid).toBe(true)
    if (!original.valid) return

    const amendment = compileOrchestrationPlanHtml(
      `<h1>PRD: Stable workers</h1>
<section data-stage="01" data-title="Existing" data-complexity="medium">
<ul data-files><li>src/existing.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">Existing work succeeds.</div>
</section>
<section data-stage="02" data-title="Independent" data-complexity="high">
<ul data-files><li>src/independent.ts</li></ul>
<div data-acceptance="02.1" data-status="pending">Independent work succeeds.</div>
</section>
<section data-stage="03" data-title="Dependent" data-depends-on="01" data-complexity="low">
<ul data-files><li>src/dependent.ts</li></ul>
<div data-acceptance="03.1" data-status="pending">Dependent work succeeds.</div>
</section>`,
      configured,
      { previousStages: original.projection.stages }
    )

    expect(amendment.valid).toBe(true)
    if (!amendment.valid) return
    expect(
      amendment.projection.stages.map((item) => item.assignment?.agentId)
    ).toStrictEqual(["agent-01", "agent-02", "agent-01"])
    expect(amendment.projection.stages[1]?.executionStatus).toBe("queued")
  })

  it("preserves the exact configured Codex model id in canonical HTML", () => {
    const source = `<h1>PRD: Preserve the route</h1>
<section data-stage="01" data-title="Ship" data-complexity="medium">
<div data-assignment data-agent-id="worker-ship" data-cli="claude" data-model="opus" data-reason="Planner choice" data-status="queued"></div>
<ul data-files><li>src/ship.ts</li></ul>
<div data-acceptance="01.1" data-status="pending">The route is preserved.</div>
</section>`
    const parsed = parsePlanHtml(source)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return

    const routing: WorkerRoutingConfig = {
      ...configured,
      medium: { cli: "codex", model: laterPageCodexModel }
    }
    const canonical = parsePlanHtml(
      applyWorkerRoutingToPlanHtml(
        parsed.html,
        parsed.projection.stages,
        routing
      )
    )

    expect(canonical.valid).toBe(true)
    if (!canonical.valid) return
    expect(canonical.html).toContain('data-cli="codex"')
    expect(canonical.html).toContain(
      `data-model="${laterPageCodexModel}"`
    )
    expect(canonical.projection.stages[0]?.assignment).toMatchObject({
      cli: "codex",
      model: laterPageCodexModel
    })
  })

  it("applies every complexity bucket's complete reasoning route", () => {
    const source = `<h1>PRD: Preserve reasoning routes</h1>
<section data-stage="01" data-title="Low" data-complexity="low"><ul data-files></ul><div data-acceptance="01.1" data-status="pending">Low works.</div></section>
<section data-stage="02" data-title="Medium" data-complexity="medium"><ul data-files></ul><div data-acceptance="02.1" data-status="pending">Medium works.</div></section>
<section data-stage="03" data-title="High" data-complexity="high"><ul data-files></ul><div data-acceptance="03.1" data-status="pending">High works.</div></section>`
    const parsed = parsePlanHtml(source)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return

    const routed = parsePlanHtml(
      applyWorkerRoutingToPlanHtml(
        parsed.html,
        parsed.projection.stages,
        reasoningConfigured
      )
    )

    expect(routed.valid).toBe(true)
    if (!routed.valid) return
    expect(
      routed.projection.stages.map((item) => item.assignment?.reasoning)
    ).toStrictEqual([
      { enabled: true, effort: "low" },
      { enabled: true, effort: "medium" },
      { enabled: true, effort: "high" }
    ])
    expect(routed.html.match(/data-thinking-enabled="true"/g)).toHaveLength(3)
    expect(workerRoutingMismatch(routed.projection.stages, reasoningConfigured))
      .toBeNull()

    const medium = routed.projection.stages[1]
    const mediumAssignment = medium?.assignment
    if (medium === undefined || mediumAssignment === null || mediumAssignment === undefined) {
      return
    }
    const mismatched = routed.projection.stages.map((item) =>
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
