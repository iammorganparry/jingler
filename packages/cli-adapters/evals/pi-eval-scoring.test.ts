import { describe, expect, it } from "vitest"
import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import type { EvalObservation, EvalTrace } from "./behavior-contract.js"
import {
  planMarkerDropped,
  planTaskStatus,
  planTaskStatusObserved
} from "./behavior-contract.js"
import {
  scoreScenario,
  assertReportRedacted,
  redactErrorMessage,
  redactReport
} from "./pi-eval.js"
import { scenarioById } from "./pi-scenarios.js"

const scenario = (id: string) => {
  const value = scenarioById(id)
  if (value === null) throw new Error(`missing scenario ${id}`)
  return value
}

const trace = (scenarioId: string, observations: ReadonlyArray<EvalObservation>): EvalTrace => ({
  scenarioId,
  observations,
  durationMs: 10,
  tokens: 20,
  costUsd: 0,
  versions: CURRENT_RUNTIME_CONTRACTS
})

describe("pi behavior scoring", () => {
  it("passes a complete subscription-backed behavior trace", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "auth-route", route: "openai-codex-oauth" },
      { kind: "event", tag: "Done" }
    ]
    expect(scoreScenario(scenario("auth.route-pinned"), trace("auth.route-pinned", observations)).status).toBe("passed")
  })

  it("fails when subscription auth falls back to an API key", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "auth-route", route: "openai-codex-oauth" },
      { kind: "auth-fallback", from: "openai-codex-oauth", to: "api-key" },
      { kind: "event", tag: "Done" }
    ]
    const result = scoreScenario(scenario("auth.route-pinned"), trace("auth.route-pinned", observations))
    expect(result.status).toBe("failed")
    expect(result.failures).toContain("forbidden auth-fallback")
  })

  it("fails when create edit delete or rename evidence is missing", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "file-change", status: "A", path: "src/new.ts", oldPath: null },
      { kind: "event", tag: "Done" }
    ]
    const result = scoreScenario(scenario("diff.create-edit-delete-rename"), trace("diff.create-edit-delete-rename", observations))
    expect(result.failures).toEqual(expect.arrayContaining([
      "missing file-change:M:src/edit.ts",
      "missing file-change:D:src/delete.ts",
      "missing file-change:R:src/renamed.ts"
    ]))
  })

  it("fails a mutation without permission", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "permission", tool: "workspace_edit", decision: "deny" },
      { kind: "tool-effect", tool: "workspace_edit" },
      { kind: "event", tag: "Done" }
    ]
    expect(scoreScenario(scenario("permission.denied-edit"), trace("permission.denied-edit", observations)).status).toBe("failed")
  })

  it("fails when a stream has no terminal event", () => {
    const result = scoreScenario(scenario("lifecycle.complete"), trace("lifecycle.complete", [{ kind: "event", tag: "Started" }]))
    expect(result.failures).toContain("expected exactly one terminal event")
  })

  it("fails resource cleanup when close is absent", () => {
    const result = scoreScenario(
      scenario("capability.managed-resources"),
      trace("capability.managed-resources", [
        { kind: "tool-call", tool: "jingler_list_resources", risk: "read" },
        { kind: "tool-call", tool: "jingler_load_resource", risk: "read" },
        { kind: "tool-call", tool: "mcp__managed__write_file", risk: "execute" },
        { kind: "file-change", status: "A", path: "src/mcp-created.ts", oldPath: null },
        { kind: "resource", name: "managed-mcp", state: "opened" },
        { kind: "event", tag: "Done" }
      ])
    )
    expect(result.status).toBe("failed")
  })

})

describe("partial-credit scoring, plan matchers and redaction", () => {
  it("scores partial credit as the satisfied fraction of matcher checks", () => {
    const full = scoreScenario(
      scenario("diff.create-edit-delete-rename"),
      trace("diff.create-edit-delete-rename", [
        { kind: "file-change", status: "A", path: "src/new.ts", oldPath: null },
        { kind: "event", tag: "Done" }
      ])
    )
    // 5 required checks, 3 missing → 2/5.
    expect(full.score).toBeCloseTo(2 / 5)
    expect(full.status).toBe("failed")
  })

  it("zeroes the score on a hard failure regardless of matcher outcomes", () => {
    const result = scoreScenario(
      scenario("lifecycle.complete"),
      trace("lifecycle.complete", [
        { kind: "event", tag: "Started" },
        { kind: "event", tag: "Done" },
        { kind: "event", tag: "Done" }
      ])
    )
    expect(result.failures).toContain("expected exactly one terminal event")
    expect(result.score).toBe(0)
  })

  it("passes below-perfect scores only when the scenario sets passScore", () => {
    const relaxed = {
      ...scenario("diff.create-edit-delete-rename"),
      passScore: 0.4
    }
    const result = scoreScenario(
      relaxed,
      trace("diff.create-edit-delete-rename", [
        { kind: "file-change", status: "A", path: "src/new.ts", oldPath: null },
        { kind: "file-change", status: "M", path: "src/edit.ts", oldPath: null },
        { kind: "event", tag: "Done" }
      ])
    )
    expect(result.score).toBeCloseTo(3 / 5)
    expect(result.status).toBe("passed")
    expect(result.failures).not.toHaveLength(0)
  })

  it("matches persisted plan-task statuses and dropped markers", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "plan-task-status", stageId: "01", taskId: "01.a", status: "completed" },
      { kind: "plan-task-status", stageId: "01", taskId: "01.b", status: "pending" },
      { kind: "plan-marker-dropped", reason: "Plan task marker names unknown stage 99; dropped." },
      { kind: "event", tag: "Done" }
    ]
    expect(planTaskStatus("01", "01.a", "completed").matches(observations[0]!)).toBe(true)
    expect(planTaskStatus("01", "01.a", "in-progress").matches(observations[0]!)).toBe(false)
    expect(planTaskStatusObserved("01", "01.b").matches(observations[1]!)).toBe(true)
    expect(planMarkerDropped("unknown stage 99").matches(observations[2]!)).toBe(true)
    expect(planMarkerDropped("unknown task").matches(observations[2]!)).toBe(false)
    expect(planMarkerDropped().matches(observations[2]!)).toBe(true)
  })

})

describe("report redaction", () => {
  it("fails when a secret or source patch enters a report", () => {
    const secret = "sk-secret-value"
    expect(assertReportRedacted(`token=${secret}`, [secret])).toEqual(["report contains a configured secret"])
    expect(redactReport(`token=${secret}`, [secret])).toBe(`token=${"[REDACTED]"}`)
  })

  it("does not render nested provider causes", () => {
    const secret = "sk-secret-value"
    const error = new Error("provider verification failed", {
      cause: new Error(`upstream rejected ${secret}`)
    })

    expect(redactErrorMessage(error, [secret])).toBe("provider verification failed")
  })
})
