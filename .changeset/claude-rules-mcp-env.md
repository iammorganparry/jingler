---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
---

Sessions now load your Claude Code instruction files (`~/.claude/CLAUDE.md`, `~/.claude/rules/**`, the repo's `AGENTS.md`/`CLAUDE.md` and `.claude/rules/**`) for every harness, and list which ones loaded. Stdio MCP servers start with your login-shell environment, and connection errors now include the server's stderr.

Claude subagents launched from a Pi session no longer fail with `model_verification_failed`: child sessions now register the same `sonnet`/`opus`/`haiku` aliases as the parent.
