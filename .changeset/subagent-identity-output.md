---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Give every Fleet subagent genuine identity and visible output, and lay them out in a grid. A running child with no readable transcript now shows a live activity panel (agent, task, current tool, running totals) instead of a dead "not available yet". The pi vendor collapses an unresolved child onto its default "main" workflow key ("run main"); the `subagent` tool now instructs the model to always name a catalogue agent (scout/worker/reviewer/…) so children resolve to real names end-to-end, and the adapter relabels any remaining collapse honestly instead of surfacing a "main" agent. The Fleet dock is now a 4-column card grid that wraps to new rows — the dead right-hand detail panel is gone; clicking a card swaps the transcript output and the selected card carries the lifecycle controls.
