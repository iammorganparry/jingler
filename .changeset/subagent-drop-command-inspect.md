---
"@jingler/desktop": patch
---

Sub-agents that can run shell commands no longer also get the read-only command tool, so they stop picking it by mistake and failing.
