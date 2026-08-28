# Refine the Plannotator Integration

## Context

Jingler now uses `@plannotator/pi-extension@0.27.8` as the sole owner of plan creation, review, approval, execution, checklist progress, persistence, and restart recovery. The native todo list, Plan drawer, progress dock, composer summary, and transcript card are read-only projections.

The first migration works end to end, but the merged code still contains unreachable native plan mutation state in `conversation-machine.ts`. Restart recovery also needs stronger duplicate prevention, canonical path validation, visible failure handling, and behavioral coverage for missing plans and review startup failures. The embedded `WebContentsView` currently leaves an indefinite “Loading Plannotator…” fallback when its loopback page cannot load.

This refinement follows the official [Pi integration](https://docs.plannotator.ai/open-source/agents/pi) and [plan review workflow](https://docs.plannotator.ai/open-source/workflows/plan-review). Those pages were last verified against Plannotator 0.25.x, so the installed 0.27.8 package source and its Pi `>=0.79.1` peer requirement are the exact API reference for implementation. Jingler uses Pi 0.84.1.

## Approach

Keep one plan authority: Plannotator. Delete only the remaining native mutation lifecycle, while retaining compatibility types and synthetic plan events that still render historical transcripts or Plannotator projections. Make vendor-owned recovery idempotent and fail closed. Treat recovery and embedded-view failures as read-only status for the user, never as a second approval or retry state machine.

Do not reduce or redesign the vendor patch in this pass. Do not add native Approve, Revise, Retry, or checklist mutation controls.

## Files to modify

### Native lifecycle cleanup

- `apps/desktop/src/renderer/conversation-machine.ts`
- `apps/desktop/src/renderer/conversation-machine.test.ts`
- `apps/desktop/src/renderer/conversation-machine-trim.test.ts`
- `packages/core/src/conversation.ts` and tests only if reference tracing proves a compatibility event is unused

### Recovery reliability

- `patches/@plannotator__pi-extension@0.27.8.patch`
- `pnpm-lock.yaml` when the patch hash changes
- `packages/cli-adapters/src/plannotator-recovery.ts`
- `packages/cli-adapters/src/plannotator-recovery.test.ts`
- `apps/desktop/src/renderer/use-conversation.ts`
- `apps/desktop/src/renderer/conversation-pane.tsx`

### Embedded review UX

- `apps/desktop/src/main/preview-view.ts`
- `apps/desktop/src/main/preview-view.test.ts`
- `apps/desktop/src/renderer/conversation-pane.tsx`
- `packages/ui/src/composites/settings-view.tsx`
- Existing nearby UI tests or stories for changed copy/state

### Product-path coverage

- `apps/desktop/e2e/plan-mode.spec.ts`
- `apps/desktop/e2e/fixtures.ts`
- `apps/desktop/src/main/e2e/pi-fixture.ts`

## Reuse

- Reuse `plannotatorReviewPending` in `packages/cli-adapters/src/plannotator-recovery.ts` as the single retained-session detector; harden it rather than adding another recovery store.
- Reuse the patched `reviewSubmittedPlan` and `startPlanReviewBrowserSession` flow in `@plannotator/pi-extension`; the resume command must enter the same decision path as a normal submission.
- Reuse `PlannotatorProjection` and `plannotatorProjectionToPlanDocument` for every native read-only surface.
- Reuse `browserOwnerKey`, `plannotatorPartition`, `isLoopbackHttpUrl`, `isSameOriginHttpUrl`, and `BrowserPreviewError` in `apps/desktop/src/main/preview-view.ts`.
- Reuse `claimPlanAutoPresentation` and the Plannotator `reviewId` in `conversation-pane.tsx` as the only live Plan-tab presentation trigger.
- Keep `PlanDocument`, `PlanProposed`, `PlanUpdated`, and `sharedPlan` only where they still project vendor state or preserve historical transcript rendering.

## Steps

- [x] **1. Delete the inert native plan lifecycle.**
  - Remove `resumePlanId`, `resumePlanRevision`, and `planActionError` from conversation context, actor input, initialization, resets, and guards.
  - Remove unreachable `COMMENT_PLAN_STEP`, `REVISE_PLAN`, `APPROVE_PLAN`, `PLAN_APPROVAL_RESULT`, and `RESUME_PLAN` events.
  - Remove `canRoutePlanFeedback`, `startResumePlan`, optimistic plan comment/revise/approve actions, approval reconciliation, and their dead imports/helpers.
  - Remove native `PlanDraft` presentation state and handling after confirming no live producer remains; Plannotator `reviewId` already drives presentation.
  - Preserve only the read-only projection path needed by transcript history and current Plannotator state.
  - Add or update behavioral machine tests proving Plannotator projections still render and ordinary queued messages still flush at tool boundaries.

- [x] **2. Make restart recovery idempotent and fail closed.**
  - In the vendor patch, make `/plannotator-resume-review` no-op when the same review is already active so pane remounts cannot create duplicate servers.
  - On missing or empty plan files, clear `reviewPending`, `lastSubmittedPath`, checklist projection, and active review state together; persist and publish the terminal host state.
  - On review startup failure or cancellation, clear the pending marker before reporting the vendor-owned outcome. Never synthesize approval or execution.
  - Canonicalize the sessions root and retained session file before reading so symlink escapes fail closed, not just lexical `..` paths.
  - Keep latest-state parsing and fail closed on malformed or truncated JSONL.
  - Keep one recovery attempt per mounted session/chat and ignore late RPC results after navigation.

- [x] **3. Replace indefinite loading with explicit embedded-review status.**
  - Make `PlannotatorPreview.open` await the Plannotator page’s initial `loadURL` result instead of swallowing it.
  - Reveal the native `WebContentsView` only after a successful load.
  - Track loading and failure in `PlannotatorPlanView`; on failure, close/hide the native view and show a concise in-app error instead of permanent loading text or a Chromium error page.
  - Keep sandboxing, context isolation, no preload, loopback-only URLs, exact-origin navigation, popup denial, per-chat ephemeral partitions, and system-browser suppression unchanged.
  - Update Planning settings copy to name Plannotator Plan mode and clarify that the toggle controls read-only exploration commands, not approval.
  - Remove the native `PlanReview` pane and expose the Plan tab only while an embedded Plannotator review is active; retain the other read-only projections.
  - Inject the active Jingler theme tokens into Plannotator and refresh them when the app theme changes.
  - When Plannotator enters `executing`, persist the composer from Plan mode to Auto.

- [x] **4. Add behavioral regression coverage.**
  - Unit-test latest pending state, no pending state, missing session file, lexical escape, symlink escape, malformed/truncated JSONL, and no retained Pi session.
  - Electron-test restart recovery reopening exactly one review with the same plan, todo list, drawer, and `0/N` progress.
  - Electron-test pane/session remounts without duplicate Plannotator review sessions.
  - Electron-test deleted and empty `PLAN.md`: no review, no execution, stale projection cleared, visible failure.
  - Force review startup failure by occupying a fixed `PLANNOTATOR_PORT`; verify visible failure, cleared pending state, and no restart loop.
  - Stop or invalidate the loopback server after review publication; verify the Plan tab shows the renderer error state rather than loading forever.
  - Re-run feedback, revised `PLAN.md`, approval, automatic execution, and `N/N` completion.
  - Do not add tests that read source files or merely assert implementation strings exist.

- [x] **5. Run the complete release gates and review the diff.**
  - Run focused typechecks and tests after each cleanup slice.
  - Run full Vitest, workspace typecheck, Biome lint, Plan-mode Electron E2E, desktop packaging, and packaged-ASAR inspection.
  - Confirm the package contains pinned Plannotator 0.27.8 and the patched recovery command.
  - Confirm no active native plan mutation RPC, event, guard, action, or UI control remains.
  - Review the final diff for a single authority, minimal code, and no duplicate recovery state.

## Verification

### Focused checks

```bash
pnpm --filter @jingler/cli-adapters typecheck
pnpm --filter @jingler/desktop typecheck
pnpm --filter @jingler/ui typecheck
pnpm --filter @jingler/cli-adapters exec vitest run src/plannotator-recovery.test.ts
pnpm --filter @jingler/desktop exec vitest run src/renderer/conversation-machine.test.ts src/main/preview-view.test.ts
pnpm --filter @jingler/desktop e2e:fast -- plan-mode.spec.ts
```

### Full checks

```bash
pnpm vitest run
BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef \
CRON_SECRET=abcdef0123456789abcdef0123456789 \
BETTER_AUTH_URL=https://example.com \
MEMORY_ENABLED=false \
MEMORY_GRANT_SECRET=11111111111111111111111111111111 \
MEMORY_WORKER_SERVICE_SECRET=22222222222222222222222222222222 \
pnpm typecheck
pnpm exec biome lint .
pnpm --filter @jingler/desktop dist
```

### End-to-end acceptance

1. Submit a two-step plan and confirm the sandboxed review opens only inside the Plan tab.
2. Send anchored or global feedback, confirm the same `PLAN.md` is revised, then approve.
3. Confirm execution continues automatically in the retained Pi session and native progress moves from `0/2` to `2/2`.
4. Restart during pending review and confirm exactly one review reopens with the same read-only native projections.
5. Repeat with a missing plan, an occupied review port, and a dead loopback page; each must remain unapproved, avoid execution, and show a clear failure without a restart loop.
