---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/contracts": patch
---

Fix mid-turn steering and GitHub feedback delivery wedges. "Send now" on a queued message carrying code-reference context now interrupts the turn and replays the message through Agent.run instead of appearing dead; Stop parks the queue (rows stay on screen, inert) instead of silently deleting queued messages; a late steer reply landing while observing a remote turn no longer latches the steering guard forever. GitHub relay deliveries are no longer able to freeze a session's event stream until an app restart: acknowledgements are bounded by a timeout, the renderer sends an explicit retry nack when it cannot route a delivery, dropped acceptance callbacks (duplicate replays, unqueued rows) now settle their dispatch promises, and claimed-but-undispatched feedback outbox entries are recovered or reaped at relay stream start.
