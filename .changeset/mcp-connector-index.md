---
"@jingler/desktop": patch
---

claude.ai connectors no longer flood the prompt: Claude chats load connector tools on demand through tool search, and Jingler's MCP search lists connectors by name (searching "slack" finds the claude.ai Slack connector and says how to use it, or that it needs a Claude model). Settings › MCP shows one row per connector; an unsigned Jingler copy hides behind the claude.ai row, which offers "Remove Jingler copy".
