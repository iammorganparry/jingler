---
"@jingler/desktop": patch
---

Fix subagents failing to start: children on the Claude CLI route no longer fail with `model_verification_failed`, and foreground `delegate` children now get their tools (`command_execute`, file tools, and so on).
