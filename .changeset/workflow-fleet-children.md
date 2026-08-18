---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/ui": patch
---

Register a workflow's child agents in the Fleet and make the workflow row an unselectable group header. A foreground scripted workflow reports its children only through the workflow call trace (live) and the final results array (at completion) — neither carried a `progress` array, so no child ever registered and the Fleet showed a lone workflow container with nothing to select. Children are now synthesized from both signals (with each step's `sessionFile` attached at completion so its transcript opens), the live path keeps the workflow container and nests children beneath it, the Fleet tree renders workflow rows as non-interactive group headers, and a selection landing on a workflow resolves to its first child.
