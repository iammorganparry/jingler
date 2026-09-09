---
title: Settled sessions, compact reconciliation, and structured plans
revision: 7
---

## Context
Revision 5's product changes are implemented in the working tree. This planning pass closes the five unchecked acceptance gaps without broadening product behavior. The remaining work is test-first: add missing restart/blocker assertions and drive one representative explicit-stage plan through the real embedded review. Production code changes only if those checks expose a defect.

Idle previously conflated paused work and resolved work. Final reconciliation could overwhelm a conversation. Plans needed consistent deliverable stages with steps, tests, proposed files, and technical explanations.

Confirmed operator decisions:
- An explicit agent declaration signals completion; merely ending a response does not.
- Outstanding requested work prevents Settled. Git commits, PRs, and merging are required only when part of the task.
- Keep the embedded Plannotator review view, not a replacement native stage UI.
- During implementation, the operator added a requirement to expose `plannotator_submit_plan` in plan mode's compiled active-tool list; this is included in the structured-plan stage.

Settled means an archival candidate, not archived. New work reopens it. Existing sessions and plans must remain readable without being automatically declared complete or rewritten.

## Approach
Use `/clive-plan` principles: deliver user value in each stage, ground technical guidance in repository code, and include tests within each deliverable. Keep enhanced structured Markdown and reuse existing typed projections. No Linear issue creation, automatic archival, new dependencies, or Plannotator asset rebuild is needed.

The four original deliverables remain the stable review structure. Only five acceptance boxes remain. Closure estimate: 120 minutes—45 for Settled restart/blocker coverage, 45 for the structured Plan-mode fixture and feedback assertions, and 30 for focused/full verification. Stage 4 still depends on stage 3.

## Files to modify
Stage-local Files sections retain the full implementation inventory. Revision 6 expects edits only in:
- `packages/cli-adapters/src/agent-runner.test.ts` — prove live background tasks and concurrent sibling runs block Settled admission.
- `apps/desktop/src/renderer/conversation-machine.test.ts` — prove persisted Settled survives reload/load failure and resets on new input.
- `apps/desktop/e2e/settled-sessions.spec.ts` — restart while Settled, then reactivate.
- `packages/core/src/plannotator-projection.test.ts` — assert rich stage fields and stable checklist identity across progress updates.
- `apps/desktop/src/main/e2e/pi-fixture.ts` and `apps/desktop/e2e/plan-mode.spec.ts` — submit a valid explicit-stage fixture and revise one named stage's approach without changing its ID.

## Reuse
- `displayStatusOf` in `packages/core/src/conversation.ts:1910` already gives live activity precedence over persisted state. `packages/ui/src/app/session-filters.ts:78` owns attention-group ordering.
- `packages/cli-adapters/src/agent-runner.ts:691-741` serializes event folding, transcript writes, and publication. `BackgroundTaskStore.liveFor` and existing approval/run state supply tracked blockers. Reuse these, not timers or final-message text matching.
- `createJinglerControlTools` in `packages/cli-adapters/src/runtime/agent/pi-jingler-tools.ts:50` registers run-scoped host tools. `AgentRuntimeContext.publishEvent` already publishes Jingler-owned lifecycle events.
- `FileChangeList` already defers diffs above eight files. `packages/cli-adapters/src/runtime/agent/pi-agent-runtime.ts:128` identifies reconciliation with `reconcile:` tool IDs.
- `PlanPrdStage` in `packages/core/src/plan-document.ts:265-294` already models approach, tasks, files, notes, walkthrough, tests, and dependencies. `planStageExecutionStatus` in `packages/core/src/plan-view.ts` derives progress.

## Distinguish resolved sessions from idle work <!-- id: settled-sessions -->
As an operator, I want resolved sessions separated from paused work so I can identify archival candidates.

### Approach
- Add `settled` to persisted and displayed session states. Keep legacy `done` readable without treating historical turn completion as proof that all work is resolved. Document that the existing `SettledSessionStatus` type means non-running/persistable statuses, not only the new Settled state; avoid a broad rename.
- Add a small run-scoped `jingler_complete_session` control tool with validated input and explicit authoring guidance. It declares requested work resolved, rather than parsing prose or trusting turn completion. Use the existing event publication route; only top-level session agents may declare session completion, not child/background runs. A pending plan review remains unfinished work.
- Treat the declaration as a candidate until the run successfully ends and final workspace reconciliation succeeds. The host checks known unfinished tasks/acceptance for requested plan execution, pending questions/approvals, active sibling chats, child work, and background tasks. Proposed implementation steps in a planning-only assignment are not themselves a request to execute them. Unknown or unreadable completion evidence fails closed to Idle/Needs Input. The agent must assess untracked requested work; do not pretend the host can prove arbitrary prose requirements.
- Persist admitted completion evidence in the transcript using backward-compatible optional data, and persist session status before publishing the terminal event. Use the shared status derivation for replay and renderer updates. New user messages, steering, or external instructions invalidate the prior declaration; failure, stop, or interruption cannot produce Settled.
- Show Settled after Idle in status grouping with existing theme tokens, no pulse, and unchanged archival actions and Active/Archived/All filters. Preserve live-activity precedence across session rows, persistent tiles, hover cards, and split views.
- Revision 6 reuses the conversation-machine RPC harness for reload/failure/reset assertions and `BackgroundTaskStore.ingest` plus the existing concurrent-run fixtures for admission blockers. Extend the existing Electron spec by relaunching with the same home/user-data directories; do not add another persistence harness.

### Technical explanation
The root cause is not just a missing sidebar label. `SessionStatus` includes unused `done`, but `SettledSessionStatus` currently admits only `idle | needs-input` (`packages/core/src/domain.ts:229-250`). `persistSettledStatus` in `apps/desktop/src/renderer/conversation-machine.ts:1882-1905` derives `activity ? "needs-input" : "idle"`, so it would erase a newly persisted Settled status on reload. Completion admission must happen in the host and survive transcript replay; the renderer must consume that decision rather than independently guess it. Ordinary runtime variables named settled refer to a finished turn and retain their existing meaning.

- [x] Trace all semantic references to status schemas and event unions, then add explicit declaration and backward-compatible admitted completion data.
- [x] Apply host-side completion checks and durable status writes through the existing event/store route; reset on new work and preserve safe behavior on stale events and failed loads.
- [x] Update the shared renderer derivation, attention ordering, labels, and all typed status consumers.

### Acceptance
- [x] An ordinary successful response remains Idle; explicit completion plus resolved tracked work becomes Settled. Pending work, failed reconciliation, failure, stop, and late/duplicate events cannot settle a session. (test: packages/cli-adapters/src/agent-runner.test.ts::admits explicit session completion only after successful resolved work)
- [x] The completion tool is run-scoped, validates input, is absent from child/background roles, and cannot declare another session complete. (test: packages/cli-adapters/src/runtime/agent/pi-jingler-tools.test.ts::completion declaration stays scoped to its owning run)
- [x] Starting the renderer from a persisted Settled session preserves that status after transcript success or failure; sending new input resets it to Idle before the new run. Old Idle sessions remain Idle. (test: apps/desktop/src/renderer/conversation-machine.test.ts::preserves persisted Settled through load and reopens on new work)
- [x] A live background task or concurrent sibling run prevents admission. Electron coverage completes a session, restarts with the same persisted data, still shows Settled, then sends follow-up work and shows Idle. (test: apps/desktop/e2e/settled-sessions.spec.ts::persists Settled across restart and reopens on follow-up)

### Files
- `packages/core/src/domain.ts` — M
- `packages/core/src/domain.test.ts` — M
- `packages/core/src/conversation.ts` — M
- `packages/core/src/conversation.test.ts` — M
- `packages/cli-adapters/src/runtime/agent/pi-jingler-tools.ts` — M
- `packages/cli-adapters/src/runtime/agent/pi-jingler-tools.test.ts` — M
- `packages/cli-adapters/src/runtime/prompt/prompt-compiler.ts` — M
- `packages/cli-adapters/src/runtime/prompt/prompt-compiler.test.ts` — M
- `packages/cli-adapters/src/agent-runner.ts` — M
- `packages/cli-adapters/src/agent-runner.test.ts` — M
- `packages/cli-adapters/src/sessions.ts` — M
- `apps/desktop/src/renderer/conversation-machine.ts` — M
- `apps/desktop/src/renderer/conversation-machine.test.ts` — M
- `packages/ui/src/tokens.ts` — M
- `packages/ui/src/app/session-filters.ts` — M
- `packages/ui/src/app/session-filters.test.ts` — M
- `apps/desktop/e2e/settled-sessions.spec.ts` — A

Existing contracts/RPC/status components inherit shared types where possible; modify direct exhaustive consumers only when semantic-reference tracing or compiler checks identify a required change. Do not create another status endpoint. Test placement can follow existing runner fixtures without adding a second harness.

> complexity: high

## Keep reconciliation compact <!-- id: compact-reconciliation -->
As an operator, I want a short changed-file preview without losing access to any diff.

### Approach
- Add an optional initial row limit to `FileChangeList`; supply ten only for final reconciliation cards identified by their existing `reconcile:` ID prefix.
- Show the first ten files, then `View more (N files)` to reveal all remaining files. Show `View less` when expanded. Use a real button with expanded state and existing focus styling.
- Preserve full change data, ordering, totals, and existing file/diff actions. Keep unrelated tool/file lists unchanged.

### Technical explanation
`ToolCardView` passes every canonical change directly to `FileChangeList` (`packages/ui/src/composites/message-turn.tsx:257`). The list already prevents expensive eager diffs for more than eight files, but still mounts every row. Slice rows only at rendering time. Determine eager-diff behavior from the complete list so collapsing or expanding never accidentally mounts a large set of diff renderers. Local expansion is one independent UI state, not a new machine.

- [x] Add the optional row preview limit and accessible expansion/collapse controls to the existing list.
- [x] Pass ten for reconciliation only and add component plus real Electron coverage.

### Acceptance
- [x] Zero, one, ten, eleven, and a large file list render the expected initial rows; ten or fewer show no expansion control. (test: packages/ui/src/composites/tool-card.test.tsx::limits reconciliation to ten file rows)
- [x] Expand reveals every remaining file, hidden-file diff actions work, collapse returns to ten, and complete totals stay unchanged. Unrelated tool cards retain their current behavior. (test: apps/desktop/e2e/canonical-file-changes.spec.ts::expands and collapses final reconciliation files without losing diffs)

### Files
- `packages/ui/src/components/file-change-list.tsx` — M
- `packages/ui/src/composites/message-turn.tsx` — M
- `packages/ui/src/composites/tool-card.test.tsx` — M
- `apps/desktop/e2e/canonical-file-changes.spec.ts` — M

> complexity: low

## Make deliverable stages deterministic <!-- id: structured-plan-stages -->
As an operator, I want plans organized into deliverable stages so I can follow tasks and evaluate tests and proposed file changes.

### Approach
- Standardize `plannotator.json` and the shipped Plannotator skill on this enhanced Markdown structure, using `/clive-plan`'s deliverable, acceptance, and code-grounded technical guidance. Require stable stage IDs, intent, Approach, implementation checkboxes, Technical explanation, Acceptance with test references, Files, complexity, and dependencies where applicable.
- In documents with explicitly ID-tagged stage headings, only those headings start stages. Untagged document-level headings become sections, including trailing Verification. Keep the existing untagged legacy parser behavior for old plans without explicit stage IDs; do not rewrite historical Markdown.
- Keep a single checklist scan and its existing document-order numbering. Do not insert/reorder checkboxes merely to normalize structure. Pending acceptance checks are not completed implementation tasks.
- Validate newly submitted structured plans before review: duplicate/empty IDs, missing required stage content, unresolved/cyclic dependencies, and malformed file/test references produce actionable stage-specific diagnostics. Validate structural completeness, not existence of proposed new test files or whether implementation is already done. No-code stages explicitly say no proposed file changes and describe their applicable verification.
- Preserve permissive reading/recovery of legacy plans and partial drafts; do not replace a currently valid adopted projection with an invalid new submission. Reuse the same parsed structure for validation and projection, not parallel regular-expression parsers.
- Include `plannotator_submit_plan` and `plannotator_update_plan` in the compiled active-tool capabilities. The Pi extension already registers and allows them; the missing prompt projection made the agent treat the submit tool as unavailable.
- Revision 6 upgrades the existing `plan-mode` scripted fixture to a compact valid structured plan: untagged Context/Verification sections plus two ID-tagged deliverable stages, each with intent, Approach, Technical explanation, task, Acceptance test reference, Files, and complexity. Update the scripted `[DONE:n]` markers and existing count assertions rather than adding a parallel E2E scenario.

### Technical explanation
`packages/plannotator-ext/plan-parse.ts:390-393` treats every level-two heading as a stage. Its shipped skill asks for stage-only headings, but `plannotator.json` asks for Context, Approach, Reuse, and Verification at that same level. That conflict creates artificial stages. Explicit stage IDs provide a deterministic distinction without introducing another format or breaking untagged historical plans. `structuredStageToPlanStage` in `packages/core/src/plannotator-projection.ts` already maps tasks, test references, files, notes, and dependencies into the existing DTO.

- [x] Reconcile the two authoring instructions and implement explicit-stage/document-section parsing with legacy fallback.
- [x] Add structural submission validation using the parsed representation and preserve existing draft/recovery behavior.
- [x] Verify projection and execution markers keep the same checkbox indices and stage IDs across progress-only updates.
- [x] Restore plan submit/update tools to the compiled active-tool list and add a plan-mode regression check.

### Acceptance
- [x] This plan shape produces exactly its four deliverable stages, not Context/Approach/Files to modify/Reuse/Verification stages; legacy fixtures still parse. (test: packages/plannotator-ext/plan-parse.test.ts::separates explicit stages from document sections without renumbering checkboxes)
- [x] Submission diagnoses missing required content, duplicate IDs, bad dependencies, and malformed references; proposed new test paths and pending acceptance are allowed. (test: packages/plannotator-ext/native-review.test.ts::rejects malformed structured submission without replacing adopted state)
- [x] Stage approach, tasks, acceptance references, files, notes, dependencies, and IDs survive projection; applying a progress-only checklist update changes statuses without changing stage/task identity. (test: packages/core/src/plannotator-projection.test.ts::preserves structured stage details and checklist identity)
- [x] A valid explicit-stage plan submission renders only its two tagged deliverables as native stages, keeps Context/Verification as document sections, and completes all task/acceptance markers after approval. (test: apps/desktop/e2e/plan-mode.spec.ts::projects explicit deliverable stages without treating overview headings as work)
- [x] Plan mode exposes submit/update tools in the compiled active-tool list and completes an embedded review. (test: packages/cli-adapters/src/runtime/agent/pi-session-factory.test.ts::configures a Plan session for Plannotator planning and automatic execution)

### Files
- `packages/plannotator-ext/plan-parse.ts` — M
- `packages/plannotator-ext/plan-parse.test.ts` — M
- `packages/plannotator-ext/index.ts` — M
- `packages/plannotator-ext/native-review.test.ts` — M
- `packages/plannotator-ext/plannotator.json` — M
- `packages/plannotator-ext/skills/plannotator/SKILL.md` — M
- `packages/core/src/plannotator-projection.ts` — M
- `packages/core/src/plannotator-projection.test.ts` — M
- `apps/desktop/src/main/e2e/pi-fixture.ts` — M
- `apps/desktop/e2e/plan-mode.spec.ts` — M

> complexity: medium

## Explain and discuss each stage in Plannotator <!-- id: stage-explanations -->
As an operator, I want a technical explanation per stage so I can understand the change and request another approach before execution.

### Approach
- Keep the embedded Plannotator view and existing review/annotation/feedback lifecycle. Each stage's `### Technical explanation` describes current behavior, proposed behavior, relevant file/symbol references, and material tradeoffs. Code or diagrams are optional when useful, not required filler.
- Preserve source Markdown unchanged when it exists, including explanations, test references, and file lists. Use existing stage notes/approach/diagram fields for projection rather than adding another explanation store or generating explanations during rendering.
- Expand `reviewMarkdownOf`'s fallback for documents without source Markdown to include available overview sections, stage IDs, intent, approach, notes/walkthrough, diagrams, tasks, acceptance test references, proposed files, complexity, and dependencies. Reuse existing Markdown/block formatting if available; do not duplicate formatting logic or fabricate missing legacy details.
- Use existing text annotations and revision feedback to ask for an alternative approach. Include the stage heading/selected passage in feedback and verify it survives submission and revision. Keep accepted stage IDs and document-order progress markers stable.
- Revision 6 changes the existing denial payload to name one fixture stage and request a concrete alternative. The scripted rewrite changes only that stage's Approach/Technical explanation, resubmits the same `PLAN.md`, and leaves both explicit stage ID comments unchanged.

### Technical explanation
`packages/ui/src/screens/plan-review.tsx` opens the bundled Plannotator app. Its host's `reviewMarkdownOf` (`apps/desktop/src/main/plannotator-view.ts:123-143`) correctly prefers source Markdown, but its fallback renders only stage titles, tasks, and acceptance text. That fallback drops already modeled technical guidance and files. Improving the authored Markdown and fallback is sufficient: no new native review screen, external explanation view, bundle patch, frontend rebuild, or third-party API change is proposed.

- [x] Ensure authored stage explanations remain in the source Markdown and existing notes projection.
- [x] Extend fallback Markdown serialization to retain available structured stage details using existing block types.
- [x] Exercise stage-specific alternative-approach feedback through the existing review flow and same-file revision.

### Acceptance
- [x] Source Markdown is preserved byte-for-byte; fallback renders available explanations, approaches, tests, files, diagrams, and stable stage IDs without inventing missing legacy content. (test: apps/desktop/src/main/plannotator-view.test.ts::renders available technical stage detail when source markdown is absent)
- [x] The embedded review shows each stage's technical guidance; denial feedback names one stage, the replacement review shows that stage's alternative approach, and both stable stage IDs remain unchanged. (test: apps/desktop/e2e/plan-mode.spec.ts::revises one stage approach through embedded Plannotator feedback)

### Files
- `apps/desktop/src/main/plannotator-view.ts` — M
- `apps/desktop/src/main/plannotator-view.test.ts` — M
- `apps/desktop/src/main/e2e/pi-fixture.ts` — M
- `apps/desktop/e2e/plan-mode.spec.ts` — M

> complexity: medium
> depends: structured-plan-stages

## Verification
Revision 6 is complete when all five remaining acceptance boxes pass; previously completed coverage stays green.

1. Run focused closure tests: `pnpm exec vitest run --project cli-adapters packages/cli-adapters/src/agent-runner.test.ts --project desktop apps/desktop/src/renderer/conversation-machine.test.ts --project core packages/core/src/plannotator-projection.test.ts`.
2. Run real Electron closure coverage: `pnpm --filter @jingler/desktop e2e:fast settled-sessions.spec.ts plan-mode.spec.ts`; inspect the embedded review assertions, not screenshots alone.
3. Run `pnpm lint`, changed-package typechecks, and `pnpm test`. For root `pnpm typecheck`, supply the repository's test-safe production secret mechanism if available; otherwise report the unchanged `BETTER_AUTH_SECRET` environment blocker exactly.
4. Run `pnpm --filter @jingler/desktop e2e` before a PR. Do not add another browser harness or rerun external integration research; this closure is repo-local.
5. Mark the five acceptance boxes complete only from passing named evidence, update the implementation-verification results, and report any remaining environment blocker.

Changes to external SDK/API calls are not part of this design. If implementation requires them, research current official documentation and match pinned package versions before editing; do not change the pinned Plannotator frontend incidentally.

### Implementation verification (revision 5)
- `pnpm test` passed.
- `pnpm lint` passed with 137 existing warnings and 0 errors.
- Changed-package TypeScript checks passed, including desktop, UI, core, CLI adapters, and device agent. Root `pnpm typecheck` reached 16 successful tasks, then the server production build stopped because `BETTER_AUTH_SECRET` is not set.
- Focused Plannotator extension suite passed: 26 tests. Focused desktop/UI suite passed: 138 tests.
- Electron specs passed for Settled lifecycle, canonical reconciliation expansion, normal-session plan tools, embedded Plan-tab review/progress, and main-chat revision feedback. The full Electron suite was not run.


### Revision 6 verification results
- All five closure acceptance cases passed individually: renderer load/failure/reactivation (91-test renderer suite), host background/sibling blockers (3 focused completion cases), Settled Electron restart, projection preservation (4-test suite), explicit-stage review/progress, and stage-targeted revision.
- `pnpm test` passed; `pnpm lint` passed with 137 warnings and zero errors. Core, CLI adapters, and desktop typechecks passed.
- Root `pnpm typecheck` passed all 23 tasks using the build-only environment values already documented in `.github/workflows/ci.yml`; no production credentials were needed.
- The plan-mode suite passed 8/10 initially. The restart assertion was corrected to match stage titles and passed on rerun. The remaining hidden-review case references an unavailable split control; it remains unresolved.
- Full Electron gate was attempted with `--max-failures=1`: `actor-residency.spec.ts` failed because the MCP import modal intercepted clicks; 286 tests did not run. A subsequent four-case closure run passed three, but the same asynchronously appearing modal blocked the explicit-stage case before submission. That case passed in earlier built runs.

### Final verification (revision 7)
- `pnpm lint` passed with 136 warnings and zero errors; `pnpm test` passed; root `pnpm typecheck` passed all 23 tasks with CI's documented build-only environment.
- The combined Settled/reconciliation/Plan-mode Electron gate passed 13/13 tests in one run.
- The full 286-test Electron suite was completed in two bounded shards plus targeted reruns for tests interrupted by the 10-minute command ceiling. Shard 1 recorded 143 consecutive passes before the ceiling; its remaining Plan-mode tests passed in the 13-test gate. Shard 2 recorded 121 passes and four expected skips; each failed/interrupted remainder passed after its root fix in focused or tail-suite reruns.
- Fixes found by the broader gate include hermetic E2E HOME isolation, current multi-pane selectors/shortcuts, a missing fake GitHub PR-commits route, and a self-contained device-agent runtime archive. No known test or environment blocker remains.
