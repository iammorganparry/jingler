import { CORE_PI_SCENARIOS } from "../pi-scenarios.js"

/** Agent-level scenarios: deterministic mode proves wiring; live mode proves model selection. */
export const CODE_TOOL_UTILIZATION_SCENARIOS = CORE_PI_SCENARIOS.filter(({ id }) =>
  id.startsWith("quality.")
)
