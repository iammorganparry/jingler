import { describe, expect, it } from "vitest"
import {
  evaluateOrchestratorProcedure,
  expandOrchestratorEvalRoutes,
  ORCHESTRATOR_EVAL_SMOKE_ROUTES
} from "./orchestrator-eval.js"

const routes = [
  {
    cli: "claude" as const,
    models: [
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku 4.5" }
    ]
  },
  {
    cli: "codex" as const,
    models: [{ id: "gpt-5.6-sol", label: "gpt-5.6-sol" }]
  },
  {
    cli: "opencode" as const,
    models: [{ id: "opencode/big-pickle", label: "big-pickle" }]
  }
]

import type { PlanPrd } from "@jingler/core"

const source = (amendment = ""): PlanPrd => ({
  title: "PRD: Eval fixture",
  sections: [
    {
      id: "context",
      title: "Context",
      blocks: [{ kind: "prose", id: "c1", text: `Exercise dependency-safe orchestration. ${amendment}` }]
    }
  ],
  stages: [
    {
      id: "schema",
      title: "Schema",
      intent: "Add storage.",
      approach: [],
      files: [{ path: "src/schema.ts", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "schema.1", text: "Schema test passes.", status: "pending", evidence: null }],
      dependencies: [],
      complexity: "high",
      assignment: { agentId: "worker-api", cli: "claude", model: "haiku", reason: "Shared API dependency" },
      executionStatus: "queued"
    },
    {
      id: "api",
      title: "API",
      intent: "Expose storage.",
      approach: [],
      files: [{ path: "src/api.ts", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "api.1", text: "API test passes.", status: "pending", evidence: null }],
      dependencies: ["schema"],
      complexity: "high",
      assignment: { agentId: "worker-api", cli: "claude", model: "haiku", reason: "Shares schema dependency" },
      executionStatus: "queued"
    },
    {
      id: "docs",
      title: "Docs",
      intent: "Document the API.",
      approach: [],
      files: [{ path: "docs/api.md", change: "M" }],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "docs.1", text: "Docs are accurate.", status: "pending", evidence: null }],
      dependencies: [],
      complexity: "low",
      assignment: { agentId: "worker-docs", cli: "codex", model: "gpt-5.6-sol", reason: "Independent documentation" },
      executionStatus: "queued"
    }
  ],
  annotations: []
})

/** Mutate a plan's stage/acceptance status (agent-owned mechanical progress the eval flags). */
const withPlannerProgress = (plan: PlanPrd): PlanPrd => ({
  ...plan,
  stages: plan.stages.map((stage) => ({
    ...stage,
    executionStatus: "completed",
    acceptance: stage.acceptance.map((c) => ({ ...c, status: "passed", evidence: "trust me" }))
  }))
})

const ownedHandoff = {
  monitored: true,
  workersSettled: true,
  steeringNeeded: true,
  steered: true,
  failedWorkerIds: ["worker-api"],
  retriedWorkerIds: ["worker-api"],
  integrated: true,
  finalReported: true
}

describe("orchestrator procedure eval route expansion", () => {
  it("covers every selectable model, including Claude Haiku", () => {
    expect(expandOrchestratorEvalRoutes(routes)).toEqual([
      { cli: "claude", model: "opus" },
      { cli: "claude", model: "haiku" },
      { cli: "codex", model: "gpt-5.6-sol" },
      { cli: "opencode", model: "opencode/big-pickle" }
    ])
    expect(ORCHESTRATOR_EVAL_SMOKE_ROUTES).toContainEqual({
      cli: "claude",
      model: "haiku"
    })
  })
})

describe.each(expandOrchestratorEvalRoutes(routes))(
  "$cli/$model orchestrator procedure",
  (route) => {
    it("passes provider-neutral planning, handoff, assignment, and progress rules", () => {
      const report = evaluateOrchestratorProcedure({
        route,
        plan: source(),
        availableRoutes: routes,
        delegated: true,
        postHandoff: ownedHandoff
      })

      expect(report.passed).toBe(true)
      expect(report.assertions.every((assertion) => assertion.passed)).toBe(true)
    })

    it("preserves stable ids and includes a user amendment", () => {
      const report = evaluateOrchestratorProcedure({
        route,
        plan: source("Require an immutable audit record."),
        previousPlan: source(),
        expectedAmendment: "immutable audit record",
        availableRoutes: routes,
        delegated: true,
        task: {
          boundedSingleOutcome: false,
          changesApprovedPlan: true
        },
        postHandoff: ownedHandoff
      })

      expect(report.passed).toBe(true)
      expect(
        report.assertions.find((assertion) => assertion.id === "stable-amendment")
      ).toMatchObject({ passed: true })
    })
  }
)

describe("orchestrator direct/delegation decision eval", () => {
  it("passes bounded single-outcome work only when it is completed and verified directly", () => {
    const report = evaluateOrchestratorProcedure({
      route: { cli: "codex", model: "gpt-5.6-sol" },
      plan: null,
      availableRoutes: routes,
      delegated: false,
      task: {
        boundedSingleOutcome: true,
        independentComponents: 1
      },
      directCompleted: true,
      directVerified: true
    })

    expect(report.passed).toBe(true)
    expect(
      report.assertions.find(
        (assertion) => assertion.id === "direct-when-bounded"
      )
    ).toMatchObject({ passed: true })
  })

  it("fails unnecessary delegation of bounded work", () => {
    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      plan: source(),
      availableRoutes: routes,
      delegated: true,
      task: {
        boundedSingleOutcome: true,
        independentComponents: 1
      },
      postHandoff: ownedHandoff
    })

    expect(report.passed).toBe(false)
    expect(
      report.assertions.find(
        (assertion) => assertion.id === "direct-when-bounded"
      )
    ).toMatchObject({
      passed: false,
      evidence: expect.stringContaining("coordination overhead")
    })
  })

  it.each([
    ["parallel components", { independentComponents: 2 }],
    ["specialist benefit", { independentComponents: 1, specialistBenefit: true }],
    ["heavy verification", { independentComponents: 1, verificationHeavy: true }],
    ["approved-plan change", { independentComponents: 1, changesApprovedPlan: true }]
  ])("fails to delegate %s", (_label, signal) => {
    const report = evaluateOrchestratorProcedure({
      route: { cli: "opencode", model: "opencode/big-pickle" },
      plan: null,
      availableRoutes: routes,
      delegated: false,
      task: {
        boundedSingleOutcome: false,
        ...signal
      }
    })

    expect(
      report.assertions.find(
        (assertion) => assertion.id === "delegate-when-beneficial"
      )
    ).toMatchObject({ passed: false })
  })
})

describe("orchestrator procedure eval failures", () => {
  it("fails claimed worker evidence and abandoned post-handoff ownership", () => {
    const broken = withPlannerProgress(source())

    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      plan: broken,
      availableRoutes: routes,
      delegated: true,
      postHandoff: {
        monitored: false,
        workersSettled: false,
        failedWorkerIds: ["worker-api"],
        retriedWorkerIds: [],
        integrated: false,
        finalReported: false
      }
    })

    expect(report.passed).toBe(false)
    expect(
      report.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id)
    ).toEqual(
      expect.arrayContaining([
        "post-handoff-ownership",
        "progress-ownership"
      ])
    )
  })

  it("fails unavailable assignments and dependency ownership conflicts", () => {
    const base = source()
    const broken: PlanPrd = {
      ...base,
      stages: base.stages.map((s) =>
        s.id === "api"
          ? {
              ...s,
              assignment: { agentId: "worker-other", cli: "opencode", model: "missing", reason: "Wrong route" }
            }
          : s
      )
    }

    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      plan: broken,
      availableRoutes: routes,
      delegated: true,
      postHandoff: ownedHandoff
    })

    expect(report.passed).toBe(false)
    expect(
      report.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id)
    ).toEqual(
      expect.arrayContaining([
        // The plan is structurally valid (canonical-html passes); only its
        // routing is wrong.
        "assignments",
        "dependency-ownership",
        "available-routes"
      ])
    )
  })

  it("fails an amendment that renames a stable acceptance id", () => {
    const renamed = source("Require an immutable audit record.")
    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      plan: {
        ...renamed,
        stages: renamed.stages.map((s) =>
          s.id === "schema"
            ? { ...s, acceptance: s.acceptance.map((c) => (c.id === "schema.1" ? { ...c, id: "schema.renamed" } : c)) }
            : s
        )
      },
      previousPlan: source(),
      expectedAmendment: "immutable audit record",
      availableRoutes: routes,
      delegated: true,
      postHandoff: ownedHandoff
    })

    expect(
      report.assertions.find(
        (assertion) => assertion.id === "stable-amendment"
      )
    ).toMatchObject({
      passed: false,
      evidence: expect.stringContaining("acceptance:schema.1")
    })
  })
})
