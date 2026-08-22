import { describe, expect, it } from "vitest"
import { runDeterministicScenario } from "./deterministic-runtime.js"
import { scoreScenario } from "./pi-eval.js"
import { CORE_PI_SCENARIOS, SELECTION_PI_SCENARIOS } from "./pi-scenarios.js"

/**
 * Vitest surface for the deterministic behavior contract — the same scenarios
 * `eval:pi:deterministic` gates CI with, but runnable one at a time with
 * `pnpm vitest watch` / `-t <scenario id>` while iterating on the harness.
 * (The full-harness plan scenarios have the same DX in
 * `harness-scenarios.test.ts`; replayed real sessions in
 * `replay/replay-fixture.test.ts`.)
 */
describe("deterministic behavior scenarios", () => {
  it.each(
    [...CORE_PI_SCENARIOS, ...SELECTION_PI_SCENARIOS].map(
      (scenario) => [scenario.id, scenario] as const
    )
  )(
    "%s passes against the scripted runtime",
    async (_id, scenario) => {
      const trace = await runDeterministicScenario(scenario.id)
      const result = scoreScenario(scenario, trace)
      expect(result.failures).toEqual([])
      expect(result.status).toBe("passed")
      expect(result.score).toBe(1)
    },
    120_000
  )
})
