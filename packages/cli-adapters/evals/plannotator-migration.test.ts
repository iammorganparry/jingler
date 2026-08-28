import { describe, expect, it } from "vitest"
import {
  evaluatePlannotatorMatrix,
  evaluatePlannotatorScenario,
  PLANNOTATOR_EVAL_MATRIX,
  type PlannotatorEvalScenario
} from "./plannotator-migration.js"

describe("Plannotator migration eval matrix", () => {
  it("covers planning, review, execution, recovery, progress, and every native projection", () => {
    expect(evaluatePlannotatorMatrix()).toEqual([])
    expect(PLANNOTATOR_EVAL_MATRIX.map(({ id }) => id)).toEqual([
      "planning.restricted-tools",
      "review.feedback-resubmission",
      "execution.approval-notes-and-progress",
      "recovery.cancelled-review",
      "recovery.review-ui-failure",
      "recovery.restart-with-plan",
      "recovery.restart-missing-plan",
      "projection.all-native-surfaces"
    ])
  })

  it.each<{
    name: string
    scenario: PlannotatorEvalScenario
    rule: string
  }>([
    {
      name: "blocks execution tools during planning",
      scenario: {
        id: "mutant.planning-tool",
        events: [
          { kind: "phase", phase: "planning" },
          { kind: "tool", name: "command_execute" }
        ]
      },
      rule: "planning-tool-forbidden:command_execute"
    },
    {
      name: "requires approval before execution",
      scenario: {
        id: "mutant.no-approval",
        events: [{ kind: "phase", phase: "executing" }]
      },
      rule: "execution-requires-approval"
    },
    {
      name: "fails closed after review UI failure",
      scenario: {
        id: "mutant.auto-approve",
        events: [
          { kind: "decision", outcome: "failed" },
          { kind: "phase", phase: "executing" }
        ]
      },
      rule: "cancel-failure-or-missing-plan-must-not-execute"
    },
    {
      name: "keeps review navigation loopback-only",
      scenario: {
        id: "mutant.remote-review",
        events: [{ kind: "review", url: "https://plannotator.ai/review", sandboxed: true }]
      },
      rule: "review-must-use-loopback-http"
    },
    {
      name: "requires sandboxing",
      scenario: {
        id: "mutant.unsandboxed",
        events: [{ kind: "review", url: "http://localhost:19435", sandboxed: false }]
      },
      rule: "review-must-be-sandboxed"
    },
    {
      name: "preserves approval notes",
      scenario: {
        id: "mutant.notes-dropped",
        events: [
          { kind: "decision", outcome: "approved-with-notes", notes: "Keep rollback support" },
          { kind: "phase", phase: "executing" },
          { kind: "execution-context", text: "Execute the plan" }
        ]
      },
      rule: "approval-notes-must-reach-execution"
    },
    {
      name: "rejects skipped checklist steps",
      scenario: {
        id: "mutant.skipped-step",
        events: [
          { kind: "checklist", completed: [2], total: 2 },
          { kind: "projection", target: "todo", completed: [2], total: 2 },
          { kind: "projection", target: "drawer", completed: [2], total: 2 },
          { kind: "projection", target: "progress", completed: [2], total: 2 },
          { kind: "projection", target: "composer", completed: [2], total: 2 },
          { kind: "projection", target: "transcript", completed: [2], total: 2 }
        ]
      },
      rule: "checklist-progress-must-be-ordered-and-monotonic"
    },
    {
      name: "requires every native projection to match",
      scenario: {
        id: "mutant.stale-transcript",
        events: [
          { kind: "checklist", completed: [1], total: 1 },
          { kind: "projection", target: "todo", completed: [1], total: 1 },
          { kind: "projection", target: "drawer", completed: [1], total: 1 },
          { kind: "projection", target: "progress", completed: [1], total: 1 },
          { kind: "projection", target: "composer", completed: [1], total: 1 },
          { kind: "projection", target: "transcript", completed: [], total: 1 }
        ]
      },
      rule: "projection-out-of-sync:transcript"
    },
    {
      name: "does not execute after restart when the plan file is missing",
      scenario: {
        id: "mutant.missing-plan",
        events: [
          { kind: "restart", planExists: false },
          { kind: "phase", phase: "executing" }
        ]
      },
      rule: "cancel-failure-or-missing-plan-must-not-execute"
    }
  ])("$name", ({ scenario, rule }) => {
    expect(evaluatePlannotatorScenario(scenario).map((failure) => failure.rule)).toContain(rule)
  })
})
