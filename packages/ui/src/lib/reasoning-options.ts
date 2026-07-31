import {
  providerReasoningCapabilitiesFor,
  type CliKind,
  type ReasoningEffort
} from "@jingler/core"

/** Provider-native reasoning efforts in display order. */
export const reasoningEffortsFor = (
  cli: CliKind | undefined
): ReadonlyArray<ReasoningEffort> =>
  providerReasoningCapabilitiesFor(cli).efforts
