---
"@jingler/cli-adapters": minor
"@jingler/desktop": minor
"@jingler/ui": minor
"@jingler/auth-state": patch
"@jingler/server": patch
---

Run Claude subscription models through the locally authenticated Claude Code CLI while keeping Pi's Jingler tools, permissions, plans, transcripts, and normalized events. Claude setup now checks `claude auth login` instead of collecting a setup token. Legacy setup tokens, managed handoff, and native child inference fail closed instead of falling back to Anthropic API traffic.
