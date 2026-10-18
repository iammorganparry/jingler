---
"@jingler/cli-adapters": patch
---

Fixed the subagent capability broker rejecting a child's cwd (403 `forbidden-cwd`) after the parent called `switch_checkout` to a different repo. The broker now resolves the parent's checkout per request instead of caching it once at registration.
