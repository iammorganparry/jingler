---
name: plannotator
description: "Plan-mode rules for Jingler's embedded Plannotator extension."
---

# Jingler Plannotator plan mode

Use one Markdown scratchpad, normally `PLAN.md`. Jingler renders it in the Plan tab; do not start a server or open an external browser.

## Plan shape

Keep plans scan-first. Use a two-to-three sentence outcome, one overview flow when multiple modules or a runtime path change, then reviewable stages:

```md
## Stage title <!-- id: stable-stage-id -->
One-sentence outcome.

### Approach
- Up to three implementation choices.

- [ ] Concrete step

### Technical explanation
One short paragraph for non-obvious behavior or tradeoffs.

### Acceptance
- [ ] Observable behavior (test[unit]: path/to/test.ts::case name)

### Files
- `path/to/file.ts` — M

> complexity: low
> depends: earlier-stage-id
```

Every stage needs intent, steps, files, acceptance tests, and complexity. Keep IDs and checkbox order stable. Do not repeat stage facts in global file, reuse, approach, or verification sections.

For every staged plan, add one Mermaid overview with `%% link <nodeId> file:<path>` or `%% link <nodeId> stage:<id>`. Add stage diagrams only when their local flow differs. Put non-trivial edits in `diff path=<repo-relative path>` fences. Tag tests with `test[unit|integration|e2e|manual]: path::case`. Plans with stage IDs need `## Test strategy`.

Markers are durable execution state: `[ ]` pending, `[~]` in progress, `[-]` blocked, `[x]` completed. Use `[~]` and `[-]` only for implementation steps; acceptance is binary.

## Review loop

1. Write or revise the same plan file.
2. Submit it with `plannotator_submit_plan`.
3. Apply feedback in place and resubmit.
4. After approval, execute stages in dependency order and update markers.

Ignore stale review decisions. Missing or empty recovery plans fail closed.
