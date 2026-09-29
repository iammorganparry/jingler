---
title: Concise, visual, annotatable plans
revision: 1
---

## Outcome
Make generated plans easy to scan: a short overview, one architecture flow, and compact stage cards. Detail stays available on demand instead of filling the page.

## Proposed flow
```mermaid
flowchart LR
  prompt[Concise plan contract] --> parser[Structured Markdown parser]
  parser --> cards[Compact stage cards]
  cards --> comments[Persistent anchored threads]
  comments --> decision[Approve or request changes]
  %% link prompt file:packages/plannotator-ext/plannotator.json
  %% link cards stage:compact-plan-contract
  %% link comments stage:persistent-comments
```

## Tighten the plan contract and close silent data loss <!-- id: compact-plan-contract -->
Generate short, structured plans and preserve every valid block.

### Approach
- Replace repeated prose requirements with hard limits and a compact stage template.
- Require one overview flow for multi-module/runtime changes; use stage diagrams only when that stage changes the flow.
- Publish prose-only parsed sections and reject pathless `diff` fences instead of silently dropping content.

- [x] Update the runtime-visible planning prompt and align the plan role policy.
- [x] Fix projection of prose-only plans and validation of pathless diffs.
- [x] Keep the bundled skill text consistent, even though it is not runtime-loaded today.

### Technical explanation
The runtime prompt currently asks for context, approach, file lists, reuse notes, per-stage explanation, test strategy, and verification, which repeats the same facts. The new contract keeps one short overview and puts steps, files, tests, diagrams, and diffs in typed stage fields.

### Acceptance
- [x] Compiled instructions require compact staged output and avoid duplicate sections (test[unit]: packages/plannotator-ext/config.test.ts::requires concise structured plans)
- [x] A prose-only plan publishes its title and sections (test[unit]: packages/cli-adapters/src/runtime/agent/shared-planning.test.ts::publishes parsed sections without stages)
- [x] A `diff` fence without `path=` is rejected (test[unit]: packages/plannotator-ext/plan-validation.test.ts::rejects a pathless diff fence)

### Files
- `packages/plannotator-ext/plannotator.json` — M
- `packages/plannotator-ext/skills/plannotator/SKILL.md` — M
- `packages/plannotator-ext/plan-validation.ts` — M
- `packages/plannotator-ext/plan-validation.test.ts` — M
- `packages/plannotator-ext/config.test.ts` — M
- `packages/cli-adapters/src/runtime/prompt/role-profiles.ts` — M
- `packages/cli-adapters/src/runtime/agent/shared-planning.ts` — M
- `packages/cli-adapters/src/runtime/agent/shared-planning.test.ts` — M

> complexity: medium

## Render compact stage cards <!-- id: stage-cards -->
Turn structured stage data into a scan-first generative UI.

### Approach
- Give each stage a summary header with status, complexity, and dependency chips.
- Render tasks, file chips, and tests as first-class components.
- Keep diagrams visible; collapse technical notes and proposed diffs behind disclosure controls.

- [x] Extract a focused stage-card component from `PlanReview`.
- [x] Reuse `FileChip`, status icons, `MermaidDiagram`, `VisualBlocks`, and `PlanChangeBlock`.
- [x] Preserve revision diff and approval actions.

### Technical explanation
No DTO change is needed. `PlanPrdStage` already separates intent, tasks, files, diagrams, notes, and acceptance; the current screen simply renders most of them as one long document.

### Acceptance
- [x] A stage card exposes tasks, files, tests, status, and complexity without expanding details (test[unit]: packages/ui/src/screens/plan-review.test.tsx::renders a compact stage summary)
- [x] Notes and proposed diffs are hidden until expanded while diagrams remain visible (test[unit]: packages/ui/src/screens/plan-review.test.tsx::discloses technical detail on demand)

### Files
- `packages/ui/src/screens/plan-review.tsx` — M
- `packages/ui/src/screens/plan-review.test.tsx` — M
- `packages/ui/src/composites/plan-stage-card.tsx` — A

> complexity: medium
> depends: compact-plan-contract

## Restore persistent plan comments <!-- id: persistent-comments -->
Keep stage and text comments across rerenders and plan revisions, with lightweight replies and resolution.

### Approach
- Reuse TextQuote anchors from `plan-anchor-dom.ts` for revision-safe highlights.
- Persist threads by session/plan ID in local storage, matching existing desktop persistence patterns.
- Include open threads in request-changes feedback; omit removed upstream editor, minimap, sharing, AI, and mentions.

- [x] Add a small typed thread store with safe decode and storage-failure fallback.
- [x] Add stage/selection comment pins, replies, resolve/reopen, and orphan handling.
- [x] Serialize open threads into the existing review decision feedback.

### Technical explanation
This keeps the existing RPC unchanged: comments remain operator-side review state and are sent to the agent when changes are requested. Persistence restores collaboration across revisions without reviving the old Plannotator SPA or adding server APIs.

### Acceptance
- [x] Threads survive remount and revision updates (test[unit]: packages/ui/src/composites/plan-comment-store.test.ts::persists threads by plan id)
- [x] Anchored comments highlight matching text and remain visible as detached when text changes (test[unit]: packages/ui/src/screens/plan-review.test.tsx::reanchors or detaches selection comments)
- [x] Replies and resolution persist; only open threads enter request-changes feedback (test[unit]: packages/ui/src/screens/plan-review.test.tsx::persists thread replies and serializes open feedback)

### Files
- `packages/ui/src/composites/plan-comment-store.ts` — A
- `packages/ui/src/composites/plan-comment-store.test.ts` — A
- `packages/ui/src/composites/plan-comment-layer.tsx` — A
- `packages/ui/src/screens/plan-review.tsx` — M
- `packages/ui/src/screens/plan-review.test.tsx` — M

> complexity: high
> depends: stage-cards

## Test strategy
- **Unit:** prompt contract, parser/validation regressions, stage-card disclosure, durable thread behavior, and anchor recovery.
- **Integration:** existing plan projection and decision RPC tests confirm the structured document and feedback still cross current boundaries.
- **Manual:** submit the Kafka plan shape, verify scanability, annotate text, revise it, and confirm the thread reanchors.
