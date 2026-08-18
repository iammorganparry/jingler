---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Add a per-row follow quick-switch to the Fleet tree. Each agent row now carries a follow button (same pointer icon as the file browser's Follow toggle): one click selects the agent and points Follow at its file edits — no round trip through the row then the Files tab — and clicking the followed agent again turns Follow off. The button shows a pressed state on the agent Follow is currently tracking.
