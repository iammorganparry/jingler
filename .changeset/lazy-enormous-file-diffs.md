---
"@jingler/desktop": patch
---

Keep enormous worktree changes responsive by loading and caching only the selected file diff, using lightweight Git numstat data for change counters, and refusing individual diffs above bounded line or byte limits before they reach the renderer.
