---
"@jingler/desktop": patch
---

Checkpoint-safe workspaces now refuse file rename without changing either file. Safe mode cannot guarantee an atomic move without overwriting another writer's destination; ordinary workspaces retain rename support. Creation, safe-mode consent and routine settings disclose this restriction.

Workspace setup and cleanup recovery now show failures reliably, and Retry, Skip, Archive and Restore keep the desktop in sync without replaying hooks.
