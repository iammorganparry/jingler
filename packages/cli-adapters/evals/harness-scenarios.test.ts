import { describe, expect, it } from "vitest"
import { runDeterministicHarnessScenario } from "./deterministic-runtime.js"
import { scoreScenario } from "./pi-eval.js"
import { HARNESS_PI_SCENARIOS, scenarioById } from "./pi-scenarios.js"

/**
 * The deterministic half of the plan-progress regression guard, driven exactly
 * as `eval:pi:deterministic` drives it in CI: faux model → pi runtime →
 * `AgentTurnDriverLive` → `AgentRunner` → `PlanStore`. A failure here means
 * checkpoint markers no longer reach the persisted plan — the "agent worked
 * the plan but the panel never moved" bug.
 */
describe("full-harness plan scenarios", () => {
  it("registers every harness scenario for scoring and replay", () => {
    for (const scenario of HARNESS_PI_SCENARIOS) {
      expect(scenarioById(scenario.id)).toBe(scenario)
    }
  })

  it.each(HARNESS_PI_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s passes against the scripted harness run",
    async (_id, scenario) => {
      const trace = await runDeterministicHarnessScenario(scenario.id)
      const result = scoreScenario(scenario, trace)
      expect(result.failures).toEqual([])
      expect(result.status).toBe("passed")
      expect(result.score).toBe(1)
    },
    60_000
  )

  it("persists nothing when the turn carries no checkpoint markers", async () => {
    // The regression itself, reproduced: a plan-execution turn whose text
    // never checkpoints must leave every task pending — and that trace must
    // FAIL the persists scenario, proving the eval can see the bug.
    const trace = await runDeterministicHarnessScenario(
      "plan.task-status-silent-turn"
    )
    const persists = scenarioById("plan.task-status-persists")
    if (persists === null) throw new Error("missing persists scenario")
    const result = scoreScenario(persists, { ...trace, scenarioId: persists.id })
    expect(result.status).toBe("failed")
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "missing plan-task-status:01:01.a:completed",
        "missing plan-task-status:01:01.b:completed"
      ])
    )
    expect(
      trace.observations.filter((observation) => observation.kind === "plan-task-status")
    ).toEqual([
      { kind: "plan-task-status", stageId: "01", taskId: "01.a", status: "pending" },
      { kind: "plan-task-status", stageId: "01", taskId: "01.b", status: "pending" }
    ])
  }, 60_000)
})
