# Unified project settings and quieter checkpoint access

## Approved scope

One Projects navigation group and local project picker owns commands, preview ports and routine editing. BeUI-backed fields replace unstyled controls; command/service-port rows replace NAME=value textareas. Routine safety is summarized with full details still available. All-project history preserves deleted/unowned records, cancellation, workspace links and health without guessing project ownership or changing schemas.

Checkpoints moved to the existing editor tab strip's conversation actions menu, not the composer. One captured-session dialog lives outside menus/retained chat bodies. Empty command bars disappear, but polling and orphan Stop/failure controls remain. No checkpoint machine, execution rules, backend, permissions, dependency or version changes. Unapproved workflow drafts still save with approve:false; routine save still requires consent.

## Parent verification

- Fresh-built targeted Electron: **12 passed, 5.1 minutes**. Real workflow setup/copies/run/stop/cleanup/recovery, distinct ports/preview/reassignment, routine dispatch/sign-out/Ask refusal, checkpoint file/index/secret/backup/refusal/captured ownership, and project/consent behavior. Layout assertions and actual narrow interactions at **1500 and 900 pixels** passed.
- Remaining desktop suite: all **87 files / 304 unique cases** exercised in serial bounded batches against the same built app. Final results: **298 passed, 5 skipped, 1 pre-existing failure**. Approximately 70 minutes for final passes, plus diagnosis/retries. Live-provider/remote opt-in skips were not enabled or called passes. Logs: `/tmp/jingler-settings-e2e-batch-{0..13}.log`; ignored batch inventory/results under `out/settings-e2e-*`.
- Root `pnpm test`: **5,184 passed, 5 skipped** (4,921 +50 +53 +25 +135), about 4.5 minutes. Root lint: zero errors, existing warnings. Final root typecheck: **21 successful tasks, 1m2.1s**. Build credentials generated only in the subprocess, never printed/persisted. `git diff --check` passed.
- Parent focused behavior rerun: **30 passed**. Second writer separately reported 100 focused cases/affected typechecks; those are not added to root totals or substituted for Electron execution.
- Independent final source review **e1572704: OK/no issues found**. Earlier review identified old Electron expectations/selectors and async first-project selection resetting drafts; corrected and exercised. Reviews did not run the host gates.

## Failure triage — not hidden

1. Workflow row field names collided with Remove labels under Playwright's default substring matching. Exact field labels fixed the test targeting; all actual saved payload/execution assertions remain.
2. The old absence check for button Conversation matched the newly approved More conversation actions control. Exact legacy name preserves the old navigation assertion.
3. Rejected drag feedback was sampled after one animation frame, before React committed it. Base case passed; the corrected helper waits up to two seconds for actual rejected feedback, with a disconnected observer/cleared timeout. Same red styling, dropEffect none and unchanged layout assertions remain. All 20 cases in that batch then passed. No drag production code changed. Initial failure retained at `/tmp/jingler-settings-e2e-batch-5-first-failure.log`.
4. **Pre-existing, not caused by this PR:** `rich-plan-scratchpad.spec.ts:123` fails after restart because “Adopted the structured plan. TokenStore implemented.” is not visible. Same failure reproduced against clean base **789b3a2b** using its own built app in `out/follow-loader-baseline`; base log `/tmp/jingler-settings-plan-base.log`, branch batch12 log above. No plan/persistence code or assertions changed. The full desktop suite is NOT claimed green.

## Sources and limits

Vendored BeUI controls, matched to current [Select](https://beui.dev/components/motion/select), [Checkbox](https://beui.dev/components/motion/checkbox), [Switch](https://beui.dev/components/motion/switch) guides. Installed React 19.2.7, XState 5.32.4 / @xstate/react 6.1.0: [promise actors](https://stately.ai/docs/promise-actors). Installed Radix Dialog 1.1.19 / Dropdown Menu 2.1.20: [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu).

The attached browser returned a zero-sized viewport and empty screenshot, so no physical visual inspection is claimed from it. Actual Electron layout/interaction assertions above provide geometry evidence. Pi responses are scripted; filesystem, RPC, runtime and rendered app are real. No paid-provider/platform certification. No external QA check is configured. Semgrep, Trivy and Gitleaks unavailable; no scanner pass claimed. Pre-existing lowercase service-name/backend validation mismatch remains out of scope. No merge or release authorized.
