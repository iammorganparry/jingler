---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Replace the stacked plan dock and fleet dock above the composer with one tabbed drawer — a Plan | Fleet tab strip (with live counts) whose tab is the header and whose panel swaps between the plan task list and the Fleet agent grid. This removes the dead band that appeared between the two docks. Also fixes a Fleet display bug where a single-child workflow showed both its container and its one step as separate cards (they now dedupe to the one agent), and drops the redundant right-hand detail panel.
