---
"@jingler/desktop": patch
---

Keep the Code Review pane responsive on enormous changesets: `Sessions.diff` now returns Git numstat counts for every changed file plus a patch that carries only the files within the per-file line/byte limits and a whole-review cap, oversized files are named in a banner instead of rendered, and the renderer splits the patch once instead of once per file. A 790k-line generated changeset previously took the renderer's V8 heap from 300MB to the 4GB limit within minutes.
