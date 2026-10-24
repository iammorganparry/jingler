import { Effect, Schema } from "effect"
import { INTERACTIVE_TOOL_TIMEOUT_MS, ToolError, codeReadModes, type ToolRegistry } from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

export const MAX_WORK_MODE_SWITCHES = 2

/** What `jingler_set_work_mode` needs from the turn; present only when the chat has Auto switching on. */
export interface WorkModeHost {
  readonly approvalIsAuto: () => boolean
  /** Claims one of this turn's switches; false once the limit is spent. */
  readonly reserveSwitch: () => boolean
}

export const registerWorkModeTool = (registry: ToolRegistry, context: AgentRuntimeContext): void => {
  registry.register({
    id: "jingler_set_work_mode",
    version: "1",
    description:
      "Switch this chat between Plan (read-only investigation) and Build. Enter plan before large or risky changes. Leaving plan needs an approved plan: submit it with plannotator_submit_plan first. At most 2 switches per turn.",
    input: Schema.Struct({ mode: Schema.Literal("plan", "build"), reason: Schema.String }),
    risk: "read",
    roles: ["conversation", "plan", "plan-execution"],
    modes: codeReadModes,
    timeoutMs: INTERACTIVE_TOOL_TIMEOUT_MS,
    outputBudget: 16_000,
    cancellable: true,
    idempotency: "unsafe",
    execute: async ({ mode, reason }) => {
      const host = context.workModeHost
      if (host === undefined) throw new ToolError("forbidden", "Auto switching is off for this chat")
      if (mode === "build" && !host.approvalIsAuto() && context.planning?.planApproved?.() !== true) {
        throw new ToolError("forbidden", "Cannot switch to build: submit the plan with plannotator_submit_plan for approval first")
      }
      if (!host.reserveSwitch()) throw new ToolError("forbidden", "Work mode switch limit reached for this turn")
      await Effect.runPromise(context.publishEvent({ _tag: "WorkModeChanged", workMode: mode }))
      return { status: "switched", mode, reason }
    }
  })
}
