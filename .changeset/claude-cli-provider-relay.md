---
"@jingler/cli-adapters": minor
"@jingler/desktop": minor
"@jingler/ui": minor
"@jingler/auth-state": patch
"@jingler/server": patch
"@jingler/device-agent": patch
---

Run Claude subscription models through the locally authenticated Claude Code CLI while keeping Pi's Jingler tools, permissions, plans, transcripts, normalized events, and native subagents. Claude setup now checks `claude auth login` instead of collecting a setup token. Legacy setup tokens and unsupported managed handoffs fail closed instead of falling back to Anthropic API traffic.
