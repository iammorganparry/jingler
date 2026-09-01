# Plannotator-owned structured plans

## Context

Jingler currently has two overlapping approaches:

- the pinned Plannotator fork owns `PLAN.md`, approval/revision, execution, recovery, and checklist progress;
- Jingler projects that state into its own enhanced Steps/Guide/Workflow Plan tab.

Retire the enhanced native Plan tab. The Plannotator Markdown scratchpad becomes the only writable plan, while the Plannotator review UI is bundled with Jingler and rendered in the Plan tab without a localhost server. Native drawer, composer, transcript, and progress-dock consumers continue to receive a disposable read-only projection.

> [!IMPORTANT]
> `PLAN.md` owns structure and progress. `PlanDocument` may remain as a read-only compatibility DTO, but Jingler must not persist or edit a second plan state.

The repository is already part-way there: `packages/plannotator-ext/plan-parse.ts` parses `##` stages, nested tasks, acceptance checks, dependencies, files, diagrams, and `[ ]` / `[~]` / `[-]` / `[x]` statuses. `packages/plannotator-ext/native-review.ts` already replaced upstream's localhost server with review decisions keyed by `reviewId`. The missing pieces are durable Markdown status updates and a bundled Plannotator UI.

## Approach

### Structured scratchpad

Keep the existing constrained Markdown format and formalize it in the Plannotator skill/template rather than inventing another schema:

- each `## Stage` is a logical, reviewable commit boundary;
- stage checkboxes are ordered implementation steps, with one nested subtask level;
- `### Acceptance` checkboxes close the stage;
- `> depends: stage-id` expresses ordering;
- checkbox markers are the status store: `[ ]` pending, `[~]` in progress, `[-]` blocked, `[x]` completed.

Stages guide commit sizing only. This change will not create commits or pause execution at stage boundaries.

Update progress by surgically changing the matching checkbox marker in `PLAN.md`, then reparse the file and republish host state. Keep the existing document-order step numbering so legacy `[DONE:n]` messages remain compatible. Do not maintain a parallel mutable checklist.

### Embedded Plannotator UI

Restore only the upstream plan-review frontend from the fork's pinned **Plannotator 0.27.8** baseline and adapt its transport; do not restore code-review, annotation, or localhost-server features removed in `packages/plannotator-ext/NOTICE.md`.

Package the static frontend with the desktop app and load it in a dedicated Electron `WebContentsView` through a privileged custom app protocol, not `file://` or HTTP. Give that trusted view a dedicated sandboxed preload exposing only:

- current plan Markdown/projection and review identity;
- save/status-update requests that write `PLAN.md` through the existing extension/session path;
- approve/revise decisions correlated by `reviewId`.

Reuse the bounds, visibility, navigation-denial, and teardown behavior from `apps/desktop/src/main/preview-view.ts`, but keep Plannotator views separate from generic browser sessions and BrowserControl. The renderer owns only a placeholder and reports its rectangle; the main process owns the native view.

This follows Electron's current guidance to prefer a custom protocol over privileged `file://` content and to use isolated, sandboxed web contents: [protocol API](https://www.electronjs.org/docs/latest/api/protocol), [security guidance](https://www.electronjs.org/docs/latest/tutorial/security). Upstream behavior and assets should be matched to the installed fork baseline, with current upstream used only as reference: [Plannotator Pi extension](https://github.com/backnotprop/plannotator/tree/main/apps/pi-extension).

### Native projection cleanup

Keep `plannotatorProjectionToPlanDocument` as the single mapping for native progress consumers. Replace `PlanReview`'s enhanced editor with the embedded-view placeholder and remove Steps/Guide/Workflow, comments, diff evidence, and native floating review actions once the embedded UI owns those actions.

Preserve:

- Plan-tab availability before and after approval;
- native transcript/task-list/composer/progress projections;
- pending-review restart recovery and fail-closed missing/empty `PLAN.md` behavior;
- legacy flat checklist decoding during migration.

## Files to modify

| Area | Critical paths |
| --- | --- |
| Plan format and durable progress | `packages/plannotator-ext/plan-parse.ts`, `packages/plannotator-ext/generated/checklist.ts`, `packages/plannotator-ext/index.ts`, `packages/plannotator-ext/skills/plannotator/SKILL.md` |
| Review transport/assets | `packages/plannotator-ext/native-review.ts`, restored pinned plan-review frontend assets under `packages/plannotator-ext/`, `packages/plannotator-ext/NOTICE.md` |
| Read-only projection | `packages/core/src/plannotator-projection.ts`, `packages/core/src/plannotator-projection.test.ts`, CLI-adapter projection tests |
| Desktop native view | new focused `apps/desktop/src/main/plannotator-view.ts`, dedicated preload entry, `apps/desktop/src/main/index.ts`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/electron-builder.yml` |
| Plan-tab placeholder | `packages/ui/src/screens/plan-review.tsx`, renderer composition/hooks that currently pass `PlanEditor` props |
| Retired enhanced UI | `packages/ui/src/composites/plan-editor.tsx` and now-unreferenced `plan-*` children/exports; related native-only tests |
| End-to-end behavior | `apps/desktop/e2e/plan-mode.spec.ts`, `README.md` |

Exact RPC/store files between `pi-session-factory` and the renderer should be changed only where needed to carry embedded-view events; the existing `plannotator:host-state` and review-decision channels remain the domain transport.

## Reuse

- `parsePlanMarkdown` in `packages/plannotator-ext/plan-parse.ts` for the stage/task model and stable flat numbering.
- `CHECKLIST_PATTERN` and `[DONE:n]` extraction in `packages/plannotator-ext/generated/checklist.ts` for precise checkbox matching.
- `startNativePlanReviewSession` in `packages/plannotator-ext/native-review.ts` for stale/duplicate-safe review decisions.
- `plannotatorProjectionToPlanDocument` in `packages/core/src/plannotator-projection.ts` for disposable native progress projections.
- `PreviewViewServiceLive` patterns in `apps/desktop/src/main/preview-view.ts` for secure `WebContentsView` lifecycle and renderer-owned bounds.
- Existing Plannotator restart recovery and host-state subscriptions in `packages/cli-adapters/src/runtime/agent/pi-session-factory.ts`.

## Steps

- [ ] **Stage 1 — Make `PLAN.md` the complete durable state.** Document the existing stage convention and logical commit-boundary rule; add a minimal checkbox-marker updater so pending/in-progress/blocked/completed changes are written atomically to the Markdown scratchpad, reparsed, and republished without changing step numbering.
- [ ] **Stage 2 — Restore and adapt the pinned plan-review frontend.** Bring back only the 0.27.8 plan-review assets with provenance, remove HTTP assumptions, and connect its load/save/status/review actions to a narrow host bridge keyed by plan path and `reviewId`.
- [ ] **Stage 3 — Embed the bundled UI.** Register the custom protocol, package the assets, add a dedicated sandboxed `WebContentsView` plus preload, and implement open/bounds/visibility/session-switch/reload/teardown behavior for Plan-tab placeholders.
- [ ] **Stage 4 — Retire the enhanced native Plan tab.** Replace `PlanEditor` with the embedded placeholder; remove native Steps/Guide/Workflow/comments/diff/floating-action code and redundant writable-plan plumbing only after references are gone, while retaining the read-only projection used outside the tab.
- [ ] **Stage 5 — Lock recovery and progress behavior.** Update focused unit and Electron tests, product docs, and third-party notices; prove review, revision, execution progress, restart recovery, and packaged-asset loading without localhost web contents.

## Verification

- Parser/status unit tests: multiple stages, nested tasks, all four markers, acceptance checks, duplicate text, malformed input, atomic rewrite, and legacy `[DONE:n]` numbering.
- Projection tests: every Markdown marker maps to the expected task/stage state, while no extra writable state is introduced.
- Native-view tests: only the packaged custom scheme loads; navigation/window opening is denied; bounds, hide/show, chat/session switching, teardown, and stale `reviewId` decisions behave correctly.
- Desktop E2E: create, edit, revise, approve, execute, and recover the same `PLAN.md`; verify the Plan tab persists after approval and native progress consumers stay synchronized.
- Run focused package tests, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the focused desktop E2E in both dev and packaged builds.

> [!NOTE]
> This intentionally does not port the enhanced tab's Guide, Workflow graph, inline comments, or live diff evidence into Plannotator. The requested carry-over is structured committable stages plus durable step status. Add other views only when there is a concrete Plannotator-side requirement.
