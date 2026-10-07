# Phase 2 implementation and validation

Checkout: `/Users/morganparry/jingler/worktrees/jingler/keen-planck`.
Starting HEAD: `af2242ff`. No worktree changes, branch transfers, pushes or releases.
The existing checkpoint/routine files are retained. The conductor plan update belongs to the parent and is excluded from this phase's commit.

## Implementation

- Shared allocator probes IPv4 and IPv6 loopback, reserves every persisted assignment including archives, and is called inside the SessionStore write semaphore for new/existing-branch, PR, issue and requested-ID/routine creation.
- Existing assignments survive reload unchanged; deletion removes their reservation. Explicit reassignment closes admission, refuses owned activity and persists under the same semaphore.
- Approved project settings carry app/service starting ports and HTTP(S) preview templates. Port configuration participates in the approval digest. Re-registration retains workflow settings.
- Workspace variables are derived by the host. The shared sanitization strips inherited workspace variables; native adapters attach only validated workspace keys after credential filtering. No added global process.env writes or credential allowlist expansion.
- Setup/run/cleanup, PTYs, Pi command_execute and its capability-broker children, native Claude/Codex/OpenCode process environments receive the session variables. Native child specs inherit the parent workspace environment.
- Codex thread/start and resume apply individual shell_environment_policy.set key overrides, preserving the operator's inheritance/include/exclusion policy and other set values. Generated protocol files are untouched.
- Port-dependent Pi workspaces bypass compute offload. Applications and shell startup configuration can still override their own environment/configuration.
- Open preview checks HTTP readiness before revealing/focusing the existing browser dock. Errors allow another Open preview attempt. Check ports reports listeners or competing persisted assignments without killing them.
- The optional checkpointSafeMode remains optional and default parallel behavior is unchanged.

## Commands and results

- `pwd; git status --short`: expected checkout; initially clean.
- `codex --version`: 0.160.0. Vendored protocol stays 0.153.2.
- `codex app-server generate-json-schema --out /tmp/jingler-phase2-codex-schema`: passed; thread/start accepts config override map. The matching official docs/version preflight was read. No generated repository files changed.
- `pnpm exec vitest run packages/cli-adapters/src/sessions.test.ts packages/cli-adapters/src/runtime/tools/workspace-mutation-tools.test.ts packages/cli-adapters/src/worktree-env.test.ts packages/cli-adapters/src/project-workflow.test.ts packages/ui/src/composites/project-workflow-settings.test.tsx`: 114 passed across 5 files. Store tests exercise the actual allocator/write lock with an explicitly deterministic listener probe; they do not claim real socket verification.
- `pnpm exec vitest run packages/cli-adapters/src/runtime/codex/runtime.test.ts -t 'actual concurrent Codex|keeps Codex operator'`: 2 passed, 38 unrelated tests skipped. Actual spawned fixture child shells see distinct session values; operator-policy preservation is covered. This is not live model execution against the installed vendor CLI.
- `pnpm exec vitest run packages/cli-adapters/src/workspace-ports.test.ts -t 'restricts|passes only|skips listeners'`: 3 passed; real-socket tests excluded explicitly.
- `pnpm exec vitest run packages/cli-adapters/src/workspace-ports.test.ts`: blocked/failed real socket tests. Both 127.0.0.1 and ::1 listen return EPERM in this sandbox; no fallback bypass was added.
- `pnpm --filter @jingler/cli-adapters typecheck`: passed.
- `pnpm --filter @jingler/ui typecheck`: passed.
- `pnpm --filter @jingler/contracts typecheck`: passed.
- `pnpm --filter @jingler/desktop typecheck`: failed only on preserved phase4 missing Routines RPC handlers. Tiny compatibility corrections removed the duplicate checkpointSafeMode field, supplied the routines test path and exported routine-store.
- `pnpm exec biome lint $(git diff --name-only -- '*.ts' '*.tsx' '*.mjs') packages/cli-adapters/src/workspace-ports.ts packages/cli-adapters/src/workspace-ports.test.ts apps/desktop/e2e/workspace-ports.spec.ts --max-diagnostics=200`: fails on two unchanged phase1 cognitive-complexity errors in Sessions.delete and copyApprovedFile. They require the pending phase1 safety merge. Other diagnostics are warnings.
- `pnpm exec oxlint -c .oxlintrc-complexity.json $(git diff --name-only -- '*.ts' '*.tsx' '*.mjs') packages/cli-adapters/src/workspace-ports.ts apps/desktop/e2e/workspace-ports.spec.ts`: passed with warnings; new form/bar complexity errors were corrected, not mislabeled as baseline.
- `pnpm --filter @jingler/desktop e2e workspace-ports.spec.ts`: failed in global build setup; tsx cannot listen on its /tmp IPC socket (EPERM). No Electron spec executed. The spec drives two fixture servers, distinct browser contents, readiness retry, stop and archive without cross-killing.
- `git diff --check`: passed.

Logs are in `/tmp/phase2-*.log`. Full root lint/typecheck/test and full e2e have not been claimed green.

## Remaining acceptance gates

A reviewer must run real IPv4/IPv6 probes and built Electron e2e in an environment that permits listeners. Complete phase4 handlers and integrate phase1 safety before the whole application gates can pass. Live authenticated vendor Codex shell execution was not exercised; this checkout's generated protocol version remains unchanged. Failed allocation can leave the newly created, unpersisted worktree for operator recovery, following the existing creation-failure behavior; no destructive cleanup was introduced.

## Commit result

Requested local staging was attempted with an explicit phase2 file list. `git add` failed (exit 128): Git cannot create `/Users/morganparry/repos/jingler/.git/worktrees/keen-planck/index.lock` inside this workspace-write sandbox. No wider roots/access were requested. No commit was created; HEAD remains `af2242ff`. `git diff --cached --name-only` is empty. Parent-owned conductor-plan and checkpoint-review documentation was not edited or staged by this writer.
