import { Schema } from "effect"

/** Provider-native effort values accepted at the shared adapter boundary. */
export const ReasoningEffort = Schema.Literal(
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
)
export type ReasoningEffort = Schema.Schema.Type<typeof ReasoningEffort>
