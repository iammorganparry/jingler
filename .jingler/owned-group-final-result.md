# Owned process-group shutdown result

Workspace verified: `/Users/morganparry/jingler/worktrees/jingler/keen-planck`; starting HEAD `5825726f`. No commits, staging, push, release, permissions, dependencies, auth guards, or SDK fallbacks changed.

## Root cause and measurements

The registry treated the first non-ESRCH process-group existence error as a permanent shutdown failure. Darwin can return **transient EPERM during exit/reaping**, even for the owned detached child just successfully signaled by this process. This invalidated endpoint discovery and retained workflow admission prematurely.

Measured here with actual detached Node subprocesses: 100 spawn/SIGTERM/negative-PGID signal-0 polling iterations produced 34 transient EPERM responses and **100 eventual ESRCH responses**. Samples included PID 9336, spawned=true, exitCode=null, signalCode=null, probe=1, EPERM; PID 9349, same state, probe=2, EPERM. A previous 200-iteration run observed 140 EPERM responses. This happens before Node reports the leader's exit as well as across caller shutdown/exit races; leader-exited alone is insufficient proof. Measurement output: `/tmp/jingler-owned-group-race-measurement.log`.

Installed Node: 24.19.0; measured Electron 43.1.0 embeds Node 24.18.0. `/bin/ps` is denied by the existing sandbox (`spawnSync /bin/ps EPERM`), so group members/zombie status were not observed directly. The zombie mechanism is inferred from Apple's current XNU source: `killpg1` finds the group, filters SZOMB members out, and returns EPERM when no signalable members remain. This explains why the standalone diagnostic that waits for the leader's exit can return ESRCH while the actual poll during shutdown fails first.

Sources reviewed before editing:

- https://nodejs.org/download/release/v24.19.0/docs/api/process.html#processkillpid-signal
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html
- https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c (`killpg1`, especially SZOMB filtering and nfound-based EPERM).

## Change

- `packages/cli-adapters/src/child-registry.ts`: retry EPERM only within the existing shutdown deadline; release a spawned group only after ESRCH. Persistent EPERM is rethrown at the deadline and ownership remains. Unknown errors still fail closed immediately. Concurrent explicit close and leader-exit shutdown share one promise, poller, and owner callback; failed attempts remain retryable. Removed/already-stopped records and unspawned groups are never signaled.
- `packages/cli-adapters/src/child-registry.test.ts`: five new regressions cover transient EPERM, persistent refusal plus retry/concurrent identity/foreign PID exclusion, spawn failure, unknown existence errors, and concurrent exit notification. Existing real detached group/grandchild and early-exit tests still pass.
- `packages/cli-adapters/src/runtime/opencode/runtime.test.ts`: actual SDK endpoint probe must report error and retain the owned group on persistent shutdown refusal; after restoring permissions the test explicitly retries shutdown.

No production diagnostic instrumentation added. The pre-existing `.jingler/process-group-diagnostic.mjs` was left untouched.

## Validation

- `pnpm exec vitest run packages/cli-adapters/src/child-registry.test.ts`: **19 passed** (`/tmp/jingler-owned-group-regressions.log`).
- `pnpm exec vitest run packages/cli-adapters/src/runtime/opencode/runtime.test.ts -t 'discovers two providers|reports .*without leaking|actual shutdown refusal|reaps a child on readiness timeout'`: **6 passed, 22 skipped** (`/tmp/jingler-owned-group-probes.log`). Includes the formerly failing ready and signed-out endpoint probes, real spawn failure, and persistent refusal propagation.
- `pnpm --filter @jingler/cli-adapters typecheck`: **passed** (`/tmp/jingler-owned-group-types.log`).
- `pnpm lint`: **passed**, existing warnings/information remain (`/tmp/jingler-owned-group-root-lint.log`).
- `git diff --check`: **passed**; `git diff --cached --name-only`: empty.
- Combined child-registry/workspace-workflow/OpenCode suites: **43 passed, 13 failed, 1 skipped**, one unhandled listen-EPERM rejection (`/tmp/jingler-owned-group-final.log`). Six workspace tests cannot allocate ports; six runtime tests fail on loopback listen EPERM; cancellation test times out after the same blocked listener prevents initialization. The baseline had 36 passed/14 failed/1 skipped before changes. Registry and endpoint probes pass after the fix; this combined run is not claimed green.
- An initial direct ESLint invocation failed because this repository uses Biome/oxlint and has no ESLint config; the required `pnpm lint` subsequently passed.

## Remaining review gate

Host root tests, root typecheck with the already planned ephemeral test-only server environment, and the real Electron feature/e2e suite must be rerun by the parent. No host escalation attempted and no production environment guard changed. Full feature/session acceptance is still pending those checks. Persistent EPERM/unknown errors intentionally continue to block cleanup/readiness rather than pretend the group is gone. `contact_supervisor` was not present in the available tool inventory; no normal-channel coordination or questions were sent.
