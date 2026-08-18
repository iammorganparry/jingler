---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/core": patch
---

Live plan progress from delegated workers, and Follow for Fleet agents. Worker sub-agents executing plan stages now update the plan panel in real time: their PLAN_TASK / PLAN_RESULT checkpoints are parsed from each worker's own stream through the same validated pipeline as the main agent's (id validation, dedupe, dropped-marker steer), where previously sub-agent events returned before the parser ran and the plan sat frozen at "0 of N completed" for the whole delegation; the plan-execution prompts now require delegations to pass the checkpoint contract into each worker's task prompt. Selecting an agent in the Fleet drawer now redirects the file browser's Follow to that agent: its file activity is derived from its own transcript with the existing deriver and published as a session-level override, so Follow's rename resolution, sandboxing, and scroll-to-hunk all work unchanged — deselecting returns Follow to the main chat.
