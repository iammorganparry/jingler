import { describe, expect, it } from "vitest"
import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import type { EvalObservation, EvalTrace } from "./behavior-contract.js"
import { scoreScenario, assertReportRedacted, redactReport } from "./pi-eval.js"
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
    expect(scoreScenario(scenario("auth.codex-subscription-pinned"), trace("auth.codex-subscription-pinned", observations)).status).toBe("passed")
  })

  it("fails when subscription auth falls back to an API key", () => {
    const observations: ReadonlyArray<EvalObservation> = [
      { kind: "auth-route", route: "openai-codex-oauth" },
      { kind: "auth-fallback", from: "openai-codex-oauth", to: "api-key" },
      { kind: "event", tag: "Done" }
    ]
    const result = scoreScenario(scenario("auth.codex-subscription-pinned"), trace("auth.codex-subscription-pinned", observations))
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
      { kind: "permission", tool: "workspace.edit", decision: "deny" },
      { kind: "tool-effect", tool: "workspace.edit" },
      { kind: "event", tag: "Done" }
    ]
    expect(scoreScenario(scenario("permission.denied-edit"), trace("permission.denied-edit", observations)).status).toBe("failed")
  })

  it("fails when a stream has no terminal event", () => {
    const result = scoreScenario(scenario("lifecycle.complete"), trace("lifecycle.complete", [{ kind: "event", tag: "Started" }]))
    expect(result.failures).toContain("expected exactly one terminal event")
  })

  it("fails resource cleanup when close is absent", () => {
    const result = scoreScenario(scenario("resource.cleanup"), trace("resource.cleanup", [
      { kind: "resource", name: "managed-mcp", state: "opened" },
      { kind: "event", tag: "Done" }
    ]))
    expect(result.status).toBe("failed")
  })

  it("fails when a secret or source patch enters a report", () => {
    const secret = "sk-secret-value"
    expect(assertReportRedacted(`token=${secret}`, [secret])).toEqual(["report contains a configured secret"])
    expect(redactReport(`token=${secret}`, [secret])).toBe(`token=${"[REDACTED]"}`)
  })
})
