---
"@jingler/desktop": patch
---

A Jingler MCP server with no sign-in no longer blocks the claude.ai connector for the same URL (e.g. Slack), so chats use your signed-in claude.ai connector instead of failing with an authorization error. Reconnect now opens the server panel and says why sign-in failed, including servers like Slack that only sign in through claude.ai.
