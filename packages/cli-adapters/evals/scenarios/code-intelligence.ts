import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { event, reportContains, toolCall, type EvalScenario } from "../behavior-contract.js"

/**
 * Baseline failure: text search cannot distinguish the exported token from a
 * same-named local. Passing requires semantic references with exact evidence.
 */
export const CODE_INTELLIGENCE_SCENARIOS: ReadonlyArray<EvalScenario> = [{
  id: "quality.semantic-references",
  capability: "code-intelligence",
  required: [
    toolCall("code_intelligence"),
    reportContains("source.ts"),
    reportContains("reexport.ts"),
    event("Done")
  ],
  forbidden: [reportContains("shadowed use.ts:2")],
  ordering: [],
  timeoutMs: 120_000,
  requiredVersions: CURRENT_RUNTIME_CONTRACTS
}]
