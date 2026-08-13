---
"@jingler/desktop": patch
---

Bound renderer memory retention. Live conversations re-read the canonical transcript tail at each idle turn boundary instead of accumulating every stream event for the life of the run, and the per-session file-browser and plan-document registries are LRU-capped instead of growing until session deletion. A multi-session day previously ballooned the renderer to a 10GB+ heap of retained tool outputs and worktree diffs.
