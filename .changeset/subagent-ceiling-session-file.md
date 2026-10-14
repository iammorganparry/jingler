---
"@jingler/desktop": patch
---

Fix subagents such as `reviewer` failing with "child tools were unavailable". The parent's tool limit is now found under the session file id that subagents look it up by.
