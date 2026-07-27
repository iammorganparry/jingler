import type { CliKind, ReasoningEffort } from "@jingler/core"

const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const

/** Provider-native reasoning efforts in display order. */
export const reasoningEffortsFor = (
  cli: CliKind | undefined
): ReadonlyArray<ReasoningEffort> =>
  cli === "claude" ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS
