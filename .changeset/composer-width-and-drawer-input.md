---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Polish the composer-owned subagent flow. The child-view composer now sits in the same gutter and centered max-width column as the conversation instead of spanning full-bleed; a busy composer respects an explicit placeholder (the child view says "Steer worker…" while live, not the main queue copy); a paused agent's send resumes it with the typed continuation; and the Fleet drawer's redundant mini steer input is gone — its details pane keeps summary, lifecycle controls (Stop stays available for paused agents), attention display, and dismiss, while the composer is the single way to message a selected agent.
