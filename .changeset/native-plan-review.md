---
"@jingler/desktop": minor
---

Plan review is now a native screen instead of the embedded upstream Plannotator bundle. Plans can include proposed code as `diff path=` blocks (rendered with Pierre, each linked to its file), typed test references (`test[unit|integration|e2e|manual]:`), a required `## Test strategy` section, and Mermaid diagrams with pan/zoom, fullscreen, and `%% link` nodes that open a stage or file. After a resubmission, reviewers can view what changed since the previous revision. Selection comments are sent back as "Plan Feedback" when changes are requested.
