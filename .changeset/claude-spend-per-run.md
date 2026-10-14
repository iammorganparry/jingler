---
"@jingler/desktop": patch
---

Fix Claude Enterprise / API-priced spend showing far too low. Each Claude Code run reports its own cost, so every turn is now kept and summed instead of only the last one.
