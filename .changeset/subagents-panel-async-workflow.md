---
"@jingler/cli-adapters": patch
---

Fix the SUBAGENTS panel staying empty while an async `workflowScript` run's children are running. A workflow child's first `subagent:async-started` event carries no `sessionId` (it is spawned inside the workflow's own detached process), only `parentWorkflowRunId` — this was rejected as not belonging to the parent session, so every workflow child was silently dropped from the Fleet projection.
