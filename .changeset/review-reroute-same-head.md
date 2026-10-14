---
"@jingler/desktop": patch
---

Fix adversarial review findings not reaching the agent when a review is run again on the same PR head. Critical and major findings are now sent to the session's chat for every fresh review, not just the first.
