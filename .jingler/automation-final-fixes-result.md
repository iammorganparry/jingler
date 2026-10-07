# Bounded final fixes — independent review required

Verified pwd: `/Users/morganparry/jingler/worktrees/jingler/keen-planck`; HEAD `cd157198d40c2288a6093104e76ddde2ddaed4f8`. Sole application writer, no stage/commit/push/release or wider access. Parent-owned `.jingler/automation-parent-plan.md` changed concurrently and was not edited by this writer. No session-completion API was called. The available tool inventory contains no `contact_supervisor`; no scope decision was needed to implement the explicitly approved fixes.

## Implemented

- Git inspection uses small exact per-command option lists for all eight supported commands. Unknown options, abbreviations, automatic negations and bundled shorts are refused before execution; only explicit harmless spellings and bounded numeric log/show counts are supported. Operand traversal includes revision-path `HEAD:../outside`. Existing forbidden error messages and normal status/log/show/diff inspections remain covered. Real configured `core.editor` sentinel never executes for rejected variants; actual allowed Git commands still run.
- Mandatory pinned backup retention excludes the selected source checkpoint. A full twenty-slot real-Git test restores the oldest checkpoint after an edit, retains the source, creates a pinned backup and stays at twenty entries. Capacity is checked before any eviction; pinned/source-only capacity exhaustion refuses.
- Host-only typed anchored requests carry `expected?: { sha256, permissions } | null`: undefined means ordinary writes, null requires absence. Restore passes this condition for create/overwrite/delete. The worker checks synchronously inside its anchored cwd immediately before rename/link/unlink; replacement checks follow temporary writes, chmod and fsync. No parent-side asynchronous validation is substituted for the worker check. Existing no-follow descent, type checks, hardlink-breaking replacement and exclusive create remain intact. Late-write wrapper regressions exercise create/overwrite/delete; worker fsync injection proves bytes, permissions and absence are checked after the temporary write. Normal writes still work.
- Before-confirm restore text explicitly says to stop external editors/watchers, that checks are best-effort, external writers cannot be locked, and late changes may be absent from the backup. The checkpoint Electron spec asserts this text.
- Archive now invokes existing `rpc.sessionsGet` before choosing ordinary archive versus terminal warning. Only CONFIRM from the warning sets acknowledgement. Failure Retry reloads and clears consent; it never implies consent. The dialog labels failure as failure/Retry. Regression starts with cached history false and fresh history true, exercises cancel, explicit confirmation and failure retry. Existing service tests prove acknowledged metadata-only archive calls no cleanup/job lifecycle paths. Electron archive additionally cancels the warning before confirming on a second attempt.
- Parent archive failure root cause: terminal creation persisted PTY history while App retained stale session flags, so the machine attempted ordinary archive and showed service refusal as consent. Fixed at fresh-load decision boundary.
- Parent routine failure root cause: WRITE in Ask correctly produced `needs-attention`; the test incorrectly expected success. Permissions are unchanged. A context-scripted `workspace-routines` Pi fixture reads README then delays ten seconds for overlap/cancel, with 64 reusable context responses for metadata calls. Success test uses READONLY, checks actual inspection transcript, shared before-turn checkpoint, isolated fresh safe Ask worktree, exact model/connection/endpoint, unchanged root README, schedule/disable/cancel and restart. Separate WRITE test expects needs-attention and proves no proof-file mutation and unchanged active-chat Ask mode. No fallback or escalation was added.

## Changed application/test files

- `packages/cli-adapters/src/runtime/tools/workspace-tools.ts`
- `packages/cli-adapters/src/runtime/tools/workspace-tools.test.ts`
- `packages/cli-adapters/src/workspace-checkpoint-store.ts`
- `packages/cli-adapters/src/workspace-checkpoint-store.test.ts`
- `packages/cli-adapters/src/anchored-fs.ts`
- `packages/cli-adapters/src/anchored-fs-worker.ts`
- `packages/cli-adapters/src/anchored-fs.test.ts`
- `apps/desktop/src/renderer/session-archive-machine.ts`
- `apps/desktop/src/renderer/session-archive-machine.test.ts`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/workspace-checkpoints-view.tsx`
- `apps/desktop/src/main/e2e/pi-fixture.ts`
- `apps/desktop/e2e/workspace-routines.spec.ts`
- `apps/desktop/e2e/workspace-terminal-archive.spec.ts`
- `apps/desktop/e2e/workspace-checkpoints.spec.ts`

## Validation evidence

PASS: `pnpm exec vitest run packages/cli-adapters/src/runtime/tools/workspace-tools.test.ts packages/cli-adapters/src/anchored-fs.test.ts packages/cli-adapters/src/workspace-checkpoint-store.test.ts packages/cli-adapters/src/sessions.test.ts apps/desktop/src/renderer/session-archive-machine.test.ts apps/desktop/src/main/routine-execution.test.ts` — six files, 112 tests passed, 43.99s (`/tmp/automation-final-all-focused.log`). Includes actual Git restoration and session/service archive regressions. Initial fsync-hook test failed because mutation of Node's CommonJS fs export did not update ESM live bindings; fixed the test using documented syncBuiltinESMExports, then all 112 passed. No production failure was waived.

PASS: `pnpm --filter @jingler/cli-adapters typecheck` and `pnpm --filter @jingler/desktop typecheck` (`/tmp/automation-final-cli-typecheck.log`, `/tmp/automation-final-desktop-typecheck.log`). Desktop tsconfig covers src, not e2e; e2e discovery validates loading only.

PASS with warnings: `pnpm exec biome lint --max-diagnostics=100` followed by the fifteen changed application/test files above — zero errors, forty warnings and one info (`/tmp/automation-final-lint.log`). Initial validator/fixture complexity errors were refactored and resolved.

FAIL: `pnpm exec oxlint -c .oxlintrc-complexity.json apps/desktop/src/main/e2e/pi-fixture.ts apps/desktop/src/renderer/session-archive-machine.ts packages/cli-adapters/src/anchored-fs.ts packages/cli-adapters/src/anchored-fs-worker.ts packages/cli-adapters/src/runtime/tools/workspace-tools.ts packages/cli-adapters/src/workspace-checkpoint-store.ts` (`/tmp/automation-final-complexity.log`). Three unchanged HEAD complexity violations: checkpoint current 34, preview 28, worker operate 27 (limit 20). Extracting these two files from immutable HEAD to `/tmp` and running the same configured oxlint reproduced precisely those scores (`/tmp/automation-final-complexity-baseline.log`). They remain unresolved; this bounded patch does not claim root lint green.

FAIL before Electron launch: `pnpm --filter @jingler/desktop e2e workspace-routines.spec.ts workspace-terminal-archive.spec.ts` — bundled plugin build cannot listen on `/tmp/tsx-501/94807.pipe`, EPERM (`/tmp/automation-final-e2e.log`). No built-app scenario is claimed passed.

PASS: `pnpm --filter @jingler/desktop exec playwright test e2e/workspace-routines.spec.ts e2e/workspace-terminal-archive.spec.ts --list` — three scenarios discovered (`/tmp/automation-final-e2e-list.log`).

PASS: `git diff --check`; `git diff --cached --name-only` empty. No files staged.

## Sources and residuals

[Official Git option API](https://git-scm.com/docs/api-parse-options/2.38.0) documents abbreviation, short-option bundling and automatic negation; its version history lists 2.38.1–2.49.1 unchanged. Exact [Git 2.39.3 branch source](https://raw.githubusercontent.com/git/git/v2.39.3/builtin/branch.c) was read. The direct 2.39.3 technical manual URL was unavailable; no claim it fetched successfully. Installed actual Git executes the normal/sentinel tests.

Exact [Node 24.19 fs](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/fs.md), [crypto](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/crypto.md) and [module](https://raw.githubusercontent.com/nodejs/node/v24.19.0/doc/api/module.md) sources were read for the existing synchronous file operations, SHA256 and test-only ESM export synchronization. Archive uses the existing installed XState fromPromise/invoke patterns; package typechecks pass.

Reviewer gate is still required. Host must rerun `pnpm --filter @jingler/desktop e2e workspace-checkpoints.spec.ts workspace-routines.spec.ts workspace-terminal-archive.spec.ts` and root lint/typecheck/test gates. E2E corrections have not yet been verified in Electron. Full root gates were not run here. Existing complexity violations are an outstanding root-lint blocker. Synchronous checking narrows the external-edit gap but cannot eliminate the final kernel race or include every external late edit in the backup. No external lock or transactional multi-file restore is claimed. Existing changesets already cover checkpoints, routines and warned archive. No release authorization is implied.
