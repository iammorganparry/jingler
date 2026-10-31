---
"@jingler/desktop": patch
---

Fix every agent turn failing with "Ambient pi resources escaped containment: extension" after the pi-subagents 0.84 upgrade. A subagent config written by an older Jingler is now rewritten instead of being kept with a key pi-subagents no longer accepts.
