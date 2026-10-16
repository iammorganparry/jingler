---
"@jingler/cli-adapters": patch
"@jingler/core": patch
---

Subagent tool calls (file reads, edits and shell commands) now run in the subagent's own worktree instead of the parent session's checkout.
