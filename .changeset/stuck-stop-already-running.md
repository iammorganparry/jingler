---
"@jingler/desktop": patch
---

Stopping an agent that's stuck inside a tool no longer locks the chat. Before, every later message (including "Sub-agent results arrived") was refused with "This chat is already running" until the stuck run eventually died.
