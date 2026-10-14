---
"@jingler/cli-adapters": patch
---

**Fixed: a reviewer subagent stayed broken for a day after one connection error.** A single failed request made subagents skip that model for 24 hours ("skipped because of a cache exclusion"). Jingler now caps that skip at 5 minutes, and existing longer skips shrink to match on the next launch.
