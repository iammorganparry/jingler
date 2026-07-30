---
"@jingler/cli-adapters": patch
---

Plan Review no longer comes up blank. Plan mode mapped our `plan` mode onto the Claude SDK's own `plan` permission mode, which hard-blocks every edit tool before `canUseTool` ever runs. A planning agent that reached for a write — drafting its plan to a file — got an opaque tool error, thrashed looking for a Write/Edit tool that wasn't there, and finally submitted `ExitPlanMode` with an empty plan argument. `parsePlan("")` produced an unstructured plan with no raw body, so the Plan Review page rendered nothing. Plan mode now maps to `default`: writes are always enabled and gated by our own `canUseTool`, exactly like every other mode. The plan-output protocol still comes from `planModeInstructions` and `ExitPlanMode` is still intercepted — only the SDK's edit hard-block is gone.
