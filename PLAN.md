---
title: Make Plannotator feel native in Jingler
revision: 1
---

## Context

The `feat/outfitter-app` transcript shows why this matters: long implementation turns currently end with raw protocol such as `[DONE:n]`, while Plan mode could not inspect Git history when the repository readers failed. The current embedded Plannotator also uses an in-memory Electron partition, suppresses its layout picker instead of remembering a choice, and renders with its bundled theme rather than Jingler’s active theme.

Commit `bd65fa13` replaced the old structured-plan system. Its prior model supported rich sections, typed blocks, stage intent/approach/tasks/files/diagrams/walkthroughs, dependencies, complexity, and explicit acceptance evidence. The current Plannotator parser and `PlanDocument` projection already retain most of that data; the main regression is that `packages/plannotator-ext/plannotator.json` tells agents to generate a generic six-section checklist instead of the richer stage shape already documented in the bundled skill.

## Approach

Fix the four problems at their existing shared entry points:

1. Add a narrowly validated, read-only command tool for Plan and Review roles instead of weakening `command_execute` or exposing unrestricted Bash.
2. Make Plannotator’s phase prompt require the existing rich Markdown stage format.
3. Let Plannotator persist one app-wide layout choice and feed the embedded view Jingler’s live theme CSS.
4. Fold every supported legacy status marker into canonical progress parts before rendering the transcript, so protocol text becomes native UI.

> [!IMPORTANT]
> The read-only command runner will execute an allowlist with `execFile`-style argument arrays. It will not invoke a shell, accept redirection/pipelines, or reclassify the existing `command_execute` tool as safe.

## Files to modify

| Area | Critical files |
| --- | --- |
| Read-only shell inspection | `packages/cli-adapters/src/runtime/tools/workspace-mutation-tools.ts`, `packages/cli-adapters/src/runtime/tools/tool-registry.ts`, `packages/cli-adapters/src/runtime/agent/pi-session-factory.ts`, focused tool/factory tests |
| Generated plan structure | `packages/plannotator-ext/plannotator.json`, `packages/plannotator-ext/skills/plannotator/SKILL.md`, `packages/cli-adapters/src/runtime/agent/locked-pi-resources.test.ts` |
| Layout persistence and theme | `apps/desktop/src/main/plannotator-view.ts`, `packages/ui/src/screens/plan-review.tsx`, their unit tests, `apps/desktop/e2e/plan-mode.spec.ts` |
| Status components | `packages/core/src/conversation.ts`, `packages/core/src/plannotator-projection.ts`, `packages/plannotator-ext/generated/checklist.ts`, `packages/ui/src/composites/message-turn.tsx`, focused core/extension/UI tests |

## Reuse

- Keep `ToolRegistry.validateExecution` in `packages/cli-adapters/src/runtime/tools/tool-registry.ts` as the final role/mode guard.
- Reuse workspace containment and bounded output behavior from `packages/cli-adapters/src/runtime/tools/workspace-tools.ts`; do not add a command library.
- Keep the structured Markdown contract in `packages/plannotator-ext/skills/plannotator/SKILL.md` and the single projection in `packages/core/src/plannotator-projection.ts`.
- Generate embedded theme CSS with `themeCssText`/`useThemeTokens` from `packages/ui/src/theme-provider.tsx`; do not create parallel theme state.
- Extend the existing `PlanTaskProgressPart` and `PlanTaskProgressChip` rather than adding a second transcript status component.

## Read-only repository inspection <!-- id: read-only-inspection -->
Give planning and review turns enough shell-like access to inspect history without allowing workspace mutation.

### Approach

- Register a separate read-risk inspection command tool for `plan` and `review` roles.
- Accept a command plus arguments as structured input and allow only repository/read programs needed for investigation: Git read operations (`status`, `diff`, `log`, `show`, `branch --list`, `grep`, `ls-tree`, `rev-parse`) and bounded text/search operations already needed when semantic tools fail.
- Reject shell metacharacters, write-capable Git subcommands/flags, paths outside the workspace, interactive commands, and unbounded output before process launch.
- Keep `command_execute`, ambient `bash`, mutation tools, installs, commits, and pushes unavailable in Plan mode.

- [x] Add the validated read-only command definition and process runner.
- [x] Expose it in Plan/Review capability assembly without changing execution-role policy.
- [x] Cover allowed Git archaeology and denied redirection, mutation, traversal, and bypass cases.

### Acceptance

- [x] A Plan session can run the equivalent of `git log`, `git show`, `git diff`, and bounded repository search. (test: `packages/cli-adapters/src/runtime/tools/workspace-tools.test.ts`)
- [x] The same session cannot write a file, invoke an interpreter, install dependencies, commit, or push. (test: `packages/cli-adapters/src/runtime/tools/tool-registry.test.ts`)
- [x] Plan session creation advertises the inspection tool but not `command_execute`, `bash`, or mutation tools. (test: `packages/cli-adapters/src/runtime/agent/pi-session-factory.test.ts`)

### Files

- `packages/cli-adapters/src/runtime/tools/workspace-mutation-tools.ts` — M
- `packages/cli-adapters/src/runtime/tools/workspace-mutation-tools.test.ts` — M
- `packages/cli-adapters/src/runtime/tools/tool-registry.test.ts` — M
- `packages/cli-adapters/src/runtime/agent/pi-session-factory.test.ts` — M

> complexity: high

## Rich generated plan shape <!-- id: rich-plan-shape -->
Restore the useful structure of enhanced plans without reviving the deleted JSON plan engine or duplicate editable state.

### Approach

- Replace the generic “Context / Approach / Files / Reuse / Steps / Verification” requirement in `plannotator.json` with the bundled rich Markdown contract: frontmatter, stable `##` stage IDs, intent, ordered approach, nested tasks, acceptance with test references, files/change kinds, diagrams/notes when useful, complexity, and dependencies.
- Keep every `##` stage sized as a reviewable commit boundary and preserve document-order checkbox numbering.
- Add prompt-contract tests that compile a Plan session and assert the rich shape reaches the model; do not rely on the skill merely existing in the catalog.

- [x] Make the phase prompt and skill agree on one rich Markdown schema.
- [x] Pin the generated prompt contract with focused runtime tests.
- [x] Verify the current parser/projector retains every documented field and add only missing parser coverage.

### Acceptance

- [x] A fresh Plan-mode prompt explicitly requires stage IDs, tasks, acceptance checks, files, complexity, and dependencies. (test: `packages/cli-adapters/src/runtime/agent/locked-pi-resources.test.ts`)
- [x] A representative rich plan round-trips through Plannotator into `PlanDocument` without flattening. (test: `packages/core/src/plannotator-projection.test.ts`)

### Files

- `packages/plannotator-ext/plannotator.json` — M
- `packages/plannotator-ext/skills/plannotator/SKILL.md` — M
- `packages/cli-adapters/src/runtime/agent/locked-pi-resources.test.ts` — M
- `packages/core/src/plannotator-projection.test.ts` — M

> complexity: medium
> depends: read-only-inspection

## Native preferences and theme <!-- id: native-plannotator -->
Make the embedded review behave like a Jingler view rather than a separate temporary app.

### Approach

- Change the isolated partition to `persist:jingler-plannotator`, remove the minified onboarding suppression patch, and let Plannotator’s existing local-storage layout preference survive restarts app-wide.
- Pass `themeCssText(useThemeTokens())` on the existing `openPlannotator` payload.
- Insert and replace that CSS in the existing `WebContentsView`, including theme changes while a plan stays open; remove the prior inserted stylesheet key to avoid accumulation.
- Map Jingler tokens onto any Plannotator-owned CSS variables/selectors that its pinned bundle actually uses, while keeping sandboxing and navigation restrictions unchanged.

- [x] Persist one app-wide layout choice and show the chooser only before the first choice.
- [x] Apply the current Jingler theme on first paint and live theme changes.
- [x] Preserve isolated protocol, sandbox, decision acknowledgement, and view lifecycle behavior.

### Acceptance

- [x] Selecting a layout, restarting Jingler, and opening another plan keeps that layout without asking again. (test: `apps/desktop/e2e/plan-mode.spec.ts`)
- [x] The embedded plan’s computed canvas, text, border, accent, fonts, and color scheme match the active Jingler theme before and after a live theme switch. (test: `apps/desktop/e2e/plan-mode.spec.ts`)
- [x] Unknown bundle changes fail visibly only for required integration hooks, not the removed onboarding string patch. (test: `apps/desktop/src/main/plannotator-view.test.ts`)

### Files

- `apps/desktop/src/main/plannotator-view.ts` — M
- `apps/desktop/src/main/plannotator-view.test.ts` — M
- `packages/ui/src/screens/plan-review.tsx` — M
- `packages/ui/src/screens/plan-review.test.tsx` — M
- `apps/desktop/e2e/plan-mode.spec.ts` — M

> complexity: medium
> depends: rich-plan-shape

## Native execution status in chat <!-- id: native-status-chat -->
Replace raw legacy markers with canonical transcript components while preserving plan-file progress.

### Approach

- Support `ACTIVE`, `DONE`, `BLOCKED`, `SKIPPED`, `FAILED`, and `INTERRUPTED` with one case-sensitive, one-based marker fold.
- Map markers to the addressed checklist item before transcript persistence, update the plan state once, remove only recognized markers from visible prose, and emit an adjacent `PlanTaskProgressPart` in program order.
- Extend the status union and existing chip metadata/icons for skipped, failed, and interrupted states; unknown/out-of-range markers remain ordinary text and do not alter the plan.
- Deduplicate repeated markers so replay/recovery is idempotent.

- [x] Extend the marker parser and canonical status model for all selected statuses.
- [x] Fold valid markers into plan progress plus native transcript parts.
- [x] Render each status through the existing accessible progress chip.

### Acceptance

- [x] `Workspace links restored. [DONE:8]` displays readable prose plus a native “step 8 completed” component, never the raw marker. (test: `packages/ui/src/composites/message-turn.test.tsx`)
- [x] Every supported marker maps to the correct plan and chip state; duplicate/replayed markers do not apply twice. (test: `packages/plannotator-ext/checklist.test.ts`)
- [x] Unknown statuses and out-of-range indices remain visible and leave plan state unchanged. (test: `packages/plannotator-ext/checklist.test.ts`)
- [x] Recovery from persisted transcripts preserves status components and checklist state. (test: `apps/desktop/e2e/rich-plan-scratchpad.spec.ts`)

### Files

- `packages/plannotator-ext/generated/checklist.ts` — M
- `packages/plannotator-ext/checklist.test.ts` — M
- `packages/core/src/conversation.ts` — M
- `packages/core/src/plannotator-projection.ts` — M
- `packages/ui/src/composites/message-turn.tsx` — M
- `packages/ui/src/composites/message-turn.test.tsx` — M
- `apps/desktop/e2e/rich-plan-scratchpad.spec.ts` — M

> complexity: medium
> depends: native-plannotator

## Verification

- [x] Run focused Vitest suites for tool policy, prompt compilation, Plannotator parsing/status, projection, embedded view, and transcript rendering.
- [x] Run `pnpm --filter @jingler/cli-adapters typecheck`, `pnpm --filter @jingler/ui typecheck`, and `pnpm --filter @jingler/desktop typecheck`.
- [x] Run the focused Electron plan-mode and rich-plan-scratchpad specs.
- [x] Manually verify first-choice layout persistence, live theme switching, rich plan review, and all six status chips in the packaged embedded view.
- [x] Run repository lint and record any unrelated pre-existing failures separately.
