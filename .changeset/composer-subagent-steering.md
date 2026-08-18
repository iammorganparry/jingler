---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Keep the real composer when a Fleet agent is selected. Selecting a sub-agent no longer swaps the composer for the drawer's mini steer input: the full composer stays, aimed at the selected agent — sends steer it (or reply to its pending question), Stop halts it, and the composer's existing follow toggle points Follow at its file edits. Model, reasoning, mode, and environment pickers are omitted in this state (they are main-turn choices). The per-row follow icon from the Fleet tree is gone — the composer's follow toggle is the one affordance. Child transcripts also now open scrolled to the END (the latest activity) and stay pinned while they grow, instead of loading at the greeting.
