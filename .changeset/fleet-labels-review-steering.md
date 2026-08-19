---
"@jingler/desktop": patch
---

Clean up collapsed Fleet labels on the durable projection (a workflow key surfacing as an agent doing "run <key>" now reads honestly — genuine names like "review-followup" are kept, bare mode tokens become "Subagent"), and steer the model away from the two subagent-orchestration mistakes that break long reviews: awaiting children inline until the workflow-script times out, and calling resume at the top level.
