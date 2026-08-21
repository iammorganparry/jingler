---
name: explain
description: Publish a focused visual explanation of the current technical topic.
---

Use `jingler_publish_explanation` to help the operator understand the current topic visually.

Skip preamble. Pick the smallest representation that makes the key point clear:

- pseudocode for logic or algorithms;
- a call tree for runtime control flow;
- a component tree for UI ownership and state;
- a shallow file tree for responsibilities or refactors;
- a diff-shaped code block when the point is what changes;
- Mermaid for component interaction, state, sequence, or data flow;
- a table for a compact comparison.

Keep only the calls, files, props, states, and boundaries needed for the current question. Place brief prose beside the visual it supports. Do not use arbitrary HTML, scripts, or styles.
