# PR #338 — refreshed acceptance

## Current host verification

- Fresh built Electron admission/features: 16/16 passed (6.6 minutes), `/tmp/jingler-pr338-acceptance-e2e.log`.
- Strengthened feature acceptance on another fresh build: 6/6 passed (3.8 minutes), `/tmp/jingler-pr338-strengthened-e2e.log`.
- `pnpm test`: 5,053 passed, 5 skipped across root and follow-on suites; `/tmp/jingler-pr338-unit.log`.
- Final `pnpm lint`: 0 errors, 88 warnings; `/tmp/jingler-pr338-lint-strengthened.log`.
- Final `pnpm typecheck`: 21 successful tasks; `/tmp/jingler-pr338-types-strengthened.log`. Production server build uses ephemeral subprocess-only build keys and `https://build.example.invalid`; no secrets printed or persisted.
- `git diff --check`: passed.

## Strengthened assertions

1. Checkpoint index contents are deliberately changed after capture, then restored alongside unstaged bytes; ignored secrets remain untouched.
2. Workflow cleanup must finish with persisted archived metadata, not merely create its marker.
3. Metadata-only terminal archive preserves an actual terminal job's heartbeat after archive; the test explicitly stops its job in `finally`.
4. Disabled routine crosses its actual due time without a new run, then remains disabled with unchanged history after app restart.

Read-only independent review found no source-proven production blocker and identified these assertion gaps; all four were strengthened and verified on the host. Prior whole-suite coverage and security reviews remain in [automation-acceptance.md](automation-acceptance.md).

## What this does not claim

Real Electron, Git, file, HTTP-server and terminal behavior is exercised; agent provider responses are scripted while using the production Pi runtime. Live paid providers, unsupported platforms, remote execution, hostile external writers, and every crash timing are not certified. Recovery races and additional lifecycle branches also have unit/service tests. No tests can establish perfect behavior. No release or merge is authorized by this acceptance.
