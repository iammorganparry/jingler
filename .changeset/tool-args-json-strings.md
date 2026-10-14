---
"@jingler/cli-adapters": patch
---

**Fixed: agents failing to ask you a question.** Some models send a list argument (like the questions in an Ask card) as JSON text instead of a list, and the tool call failed with "must be array" until you nudged the agent. Jingler now reads that text as the list it was meant to be, for every tool.
