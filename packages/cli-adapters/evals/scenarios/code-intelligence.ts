import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { event, toolCall, toolOutputContains, type EvalScenario } from "../../src/runtime/certification/behavior-contract.js"

/**
 * Baseline failure: text search cannot distinguish the exported token from a
 * same-named local. Passing requires semantic references with exact evidence.
 */
export const CODE_INTELLIGENCE_SCENARIOS: ReadonlyArray<EvalScenario> = [{
  id: "quality.semantic-references",
  capability: "code-intelligence",
  required: [
    toolCall("code_intelligence"),
    toolOutputContains("code_intelligence", "source.ts"),
    toolOutputContains("code_intelligence", "reexport.ts"),
    event("Done")
  ],
  forbidden: [toolOutputContains("code_intelligence", "\"path\":\"use.ts\",\"line\":2")],
  ordering: [],
  timeoutMs: 120_000,
  requiredVersions: CURRENT_RUNTIME_CONTRACTS
}]
