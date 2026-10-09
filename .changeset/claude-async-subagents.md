---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
---

Claude subagents started in the background now do their work. They used to stop on their first turn with a 401, because the Claude CLI provider failed to load in background children.
