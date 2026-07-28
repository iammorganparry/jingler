import type { CliKind } from "@jingler/core"
import { DEFAULT_PLAN_TEMPLATE, supportsPlanMode } from "@jingler/core"
import { planInstructions } from "./plan-parse.js"

/**
 * The per-turn instruction telling an agent how to submit a plan.
 *
 * Null for Claude: the SDK takes `planModeInstructions` as a real option
 * alongside `permissionMode: "plan"` (see `claude-adapter.ts`), and restating
 * the protocol in the prompt body would compete with the `ExitPlanMode` tool the
 * harness is already being steered toward. Null for anything that cannot plan at
 * all — cursor falls through to the scripted stub, jingler orchestrates rather
 * than runs turns.
 *
 * Everything else gets the SAME grammar via `planInstructions("reply")`, which is
 * the whole point: the block a Codex plan comes back in is parsed by the very
 * same `parsePlan` Claude's `ExitPlanMode` payload goes through, so a plan is a
 * plan regardless of who wrote it. Restart recovery depends on this route
 * — it deliberately refuses plan mode and reads a fenced block instead, so any
 * harness can hold any role.
 *
 * Rides the per-turn prompt prefix rather than a system prompt for the reason
 * `adhdNote` and `questionNote` do: no system-prompt hook is shared by every
 * harness, and a mode the operator flips mid-session has to apply to the NEXT
 * turn — which a session-start injection could not do.
 */
export const planNote = (
  cli: CliKind,
  template: string = DEFAULT_PLAN_TEMPLATE
): string | null => {
  if (cli === "claude") return null
  if (!supportsPlanMode(cli)) return null
  return [
    "PLAN MODE — you are READ-ONLY this turn. The harness sandbox will reject any",
    "edit or write command, so do not attempt one: research, then plan.",
    "",
    planInstructions("reply", template)
  ].join("\n")
}
