import type { StreamEvent } from "@jingler/core"
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

const source = (amendment = ""): string => `<h1>PRD: Eval fixture</h1>
<h2>Context</h2><p>Exercise dependency-safe orchestration. ${amendment}</p>
<section data-stage="schema" data-title="Schema" data-depends-on="" data-complexity="high">
<h3>Intent</h3><p>Add storage.</p>
<div data-assignment="worker-api" data-agent-id="worker-api" data-cli="claude" data-model="haiku" data-reason="Shared API dependency" data-status="queued"></div>
<div data-acceptance="schema.1" data-status="pending">Schema test passes.</div>
</section>
<section data-stage="api" data-title="API" data-depends-on="schema" data-complexity="high">
<h3>Intent</h3><p>Expose storage.</p>
<div data-assignment="worker-api" data-agent-id="worker-api" data-cli="claude" data-model="haiku" data-reason="Shares schema dependency" data-status="queued"></div>
<div data-acceptance="api.1" data-status="pending">API test passes.</div>
</section>
<section data-stage="docs" data-title="Docs" data-depends-on="" data-complexity="low">
<h3>Intent</h3><p>Document the API.</p>
<div data-assignment="worker-docs" data-agent-id="worker-docs" data-cli="codex" data-model="gpt-5.6-sol" data-reason="Independent documentation" data-status="queued"></div>
<div data-acceptance="docs.1" data-status="pending">Docs are accurate.</div>
</section>`

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
        source: source(),
        availableRoutes: routes,
        delegated: true,
        eventsAfterDelegation: []
      })

      expect(report.passed).toBe(true)
      expect(report.assertions.every((assertion) => assertion.passed)).toBe(true)
    })

    it("preserves stable ids and includes a user amendment", () => {
      const report = evaluateOrchestratorProcedure({
        route,
        source: source("Require an immutable audit record."),
        previousSource: source(),
        expectedAmendment: "immutable audit record",
        availableRoutes: routes,
        delegated: true,
        eventsAfterDelegation: []
      })

      expect(report.passed).toBe(true)
      expect(
        report.assertions.find((assertion) => assertion.id === "stable-amendment")
      ).toMatchObject({ passed: true })
    })
  }
)

describe("orchestrator procedure eval failures", () => {
  it("fails a planner that implements after Delegate or claims worker evidence", () => {
    const postHandoff: ReadonlyArray<StreamEvent> = [
      { _tag: "ToolStart", id: "edit-1", name: "Edit", target: "src/api.ts" }
    ]
    const broken = source()
      .replace('data-status="queued"', 'data-status="completed"')
      .replace('data-status="pending"', 'data-status="passed" data-evidence="trust me"')

    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      source: broken,
      availableRoutes: routes,
      delegated: true,
      eventsAfterDelegation: postHandoff
    })

    expect(report.passed).toBe(false)
    expect(
      report.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id)
    ).toEqual(expect.arrayContaining(["plan-only", "progress-ownership"]))
  })

  it("fails unavailable assignments and dependency ownership conflicts", () => {
    const broken = source()
      .replace(
        'data-agent-id="worker-api" data-cli="claude" data-model="haiku" data-reason="Shares schema dependency"',
        'data-agent-id="worker-other" data-cli="opencode" data-model="missing" data-reason="Wrong route"'
      )

    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      source: broken,
      availableRoutes: routes,
      delegated: true,
      eventsAfterDelegation: []
    })

    expect(report.passed).toBe(false)
    expect(
      report.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id)
    ).toEqual(
      expect.arrayContaining([
        "canonical-html",
        "assignments",
        "dependency-ownership",
        "available-routes"
      ])
    )
  })

  it("fails an amendment that renames a stable acceptance id", () => {
    const report = evaluateOrchestratorProcedure({
      route: { cli: "claude", model: "haiku" },
      source: source("Require an immutable audit record.").replace(
        'data-acceptance="schema.1"',
        'data-acceptance="schema.renamed"'
      ),
      previousSource: source(),
      expectedAmendment: "immutable audit record",
      availableRoutes: routes,
      delegated: true,
      eventsAfterDelegation: []
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
