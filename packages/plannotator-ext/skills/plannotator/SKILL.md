---
name: plannotator
description: "Plan-mode rules for Jingler's embedded Plannotator extension."
---

# Jingler Plannotator plan mode

Jingler's pinned Plannotator fork owns one Markdown scratchpad, normally `PLAN.md`. The Plan tab renders the bundled Plannotator review app. Do not start a localhost server or open an external browser.

## Plan shape

Use ordinary Markdown with this constrained structure:

```md
---
title: Short plan title
revision: 1
---

Context and approach.

## Stage title <!-- id: stable-stage-id -->
One-line intent. Size each stage so its finished changes could form one reviewable commit.

### Approach
- Ordered implementation detail

- [ ] Concrete step
  - [ ] Optional substep

### Acceptance
- [ ] Observable check (test: path/to/test.ts::case name)

### Files
- `path/to/file.ts` — M

> complexity: low
> depends: earlier-stage-id
```

Each `##` heading is a logical commit boundary, not an instruction to run `git commit`. Keep stage IDs stable across revisions. Dependencies reference those IDs.

Checkbox markers are durable execution state:

| Marker | State |
| --- | --- |
| `[ ]` | pending |
| `[~]` | in progress |
| `[-]` | blocked |
| `[x]` | completed or acceptance passed |

Use `[~]` and `[-]` only for implementation steps. Acceptance criteria are binary checks and use `[ ]` or `[x]` only. Update the same plan file in place as work advances. Do not create a second status file or reorder existing checkboxes during execution: document-order numbering is how legacy `[DONE:n]` progress markers find their step.

## Review loop

1. Write or revise the same Markdown plan file.
2. Submit it for review through the Plannotator tool.
3. If denied, apply the feedback to that file and resubmit it.
4. If approved, execute stages in dependency order and update checkbox markers as status changes.
5. Keep the plan as the scratchpad until every step and acceptance check is complete.

The review decision is correlated by `reviewId`. Ignore stale or duplicate decisions. A missing or empty plan on recovery fails closed.
