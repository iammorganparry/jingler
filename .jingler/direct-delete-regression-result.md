# Direct-session deletion regression

Workspace verified: `/Users/morganparry/jingler/worktrees/jingler/keen-planck`; HEAD `ab77bdc2`. No commits, staging, pushes, releases, desktop builds, or plugin builds were performed. Existing desktop artifacts remain available for the parent's old-artifact e2e batches. `contact_supervisor` is unavailable in this CLI toolset.

Two defects were reproduced independently in the actual main deletion handler:

- `AgentRunner.prompt` registered its workspace admission lease on the request stream scope. `stop(..., true)` stops the daemon harness, but a still-attached completed consumer retained that lease. `Sessions.delete` subsequently waited for workspace idle, even though the owned harness had stopped. The RPC regression fails with the original lease ownership (timeout); a preliminary runner assertion observed activity count 1 after full stop.
- Once idle succeeds, deletion unconditionally invoked workspace workflow cleanup. `WorkspaceWorkflowService.executeCleanup` refuses direct sessions with `Workspace cleanup requires an isolated local worktree.` Reverting only the cleanup eligibility condition reproduces this exact failure in the same RPC test.

The fix transfers admission ownership atomically to the daemon run and releases it after actual harness finalizers finish. Setup failures and refused prompts retain their request-scope fallback release. A detached consumer cannot falsely make an active background harness idle; the strengthened background test proves count 1 while live and 0 after awaited stop. No stop deadlines or e2e expectations changed.

Both local archive and delete now invoke workflow cleanup only for worktree sessions. Direct deletion still closes admission, awaits each active/closed chat's stop, stops terminals and workflow runs, waits for idle, revokes browser control, deletes previews, clears background tasks, destroys the session's offload sandbox, and removes session/transcript/context/review metadata. SessionStore's existing worktree-mode check still protects the direct checkout. Unknown PTY history is refused before shutdown or deletion in both modes; no force-delete policy was added.

Changed files:
- `packages/cli-adapters/src/agent-runner.ts`
- `packages/cli-adapters/src/agent-runner.test.ts`
- `apps/desktop/src/main/rpc.ts` (extracted the existing delete handler for direct testing)
- `apps/desktop/src/main/direct-delete.test.ts`
- `.changeset/direct-session-deletion.md`
- `.jingler/direct-delete-regression-result.md`

Tests added/updated:
- Actual main deletion handler with the real runner, workflow service, session and transcript stores, and real Git checkout; deterministic driver completes an Auto turn while its consumer remains attached. Deletion must complete within the existing 5-second unit bound and remove metadata/transcript. HEAD, refs/branches, worktree list, status, index bytes, staged/unstaged README content and untracked data remain identical.
- Unknown PTY deletion refusal in direct and worktree modes; persisted metadata and checkout remain intact.
- Existing background harness test now proves admission stays owned after renderer detach and releases only after full stop.
- Existing `apps/desktop/e2e/direct-sessions.spec.ts` is unchanged and remains the real Pi/Electron acceptance test.

Validation:
- `pnpm exec vitest run` on runner, direct-delete RPC, admission, checkpoints and metadata-only archive: 57 tests passed across 5 files (`/tmp/jingler-direct-regression-tests.log`); final-source repeat also passed all 57 tests in 5 files in 22.61 seconds (`/tmp/jingler-direct-final-tests.log`).
- Before-fix RPC probes: original request lease times out (`/tmp/jingler-direct-rpc-original-lease.log`); original cleanup condition fails with the direct/worktree error (`/tmp/jingler-direct-rpc-original-cleanup.log`). Both source reversions were restored before final gates.
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`: passed (`/tmp/jingler-direct-typecheck2.log`).
- `pnpm exec turbo run typecheck --only`: all 19 tasks passed, zero cached (`/tmp/jingler-direct-root-typecheck.log`). Wrangler printed sandbox log-file EPERM warnings, but all typecheck tasks exited successfully.
- `pnpm version:check` and `pnpm runtime-contracts:check`: passed (`/tmp/jingler-direct-policy.log`).
- `pnpm lint`: passed with existing warnings (`/tmp/jingler-direct-final-lint.log`).
- `git diff --check`: passed. Git index is empty; no staged files.
- Fresh `pnpm test`: failed; aborted with Ctrl-C (exit 130) after confirmed failures, including loopback `listen EPERM`, unavailable tsx IPC, filesystem-watch assertions, fixture Git errors and timeouts. The changed direct-delete tests (3) and runner tests (43) passed during this run. The full gate is not green here; detailed evidence is `/tmp/jingler-direct-full-test.log`. The relay/runtime tail of the root test command was not reached.

API basis: installed Effect 3.21.4 `src/Effect.ts` interruption/finalization APIs and `src/internal/fiberRuntime.ts`'s existing `disconnect` fork/restore pattern; official Effect v3 [finalization documentation](https://effect.website/docs/v3/resource-management/introduction/). No dependency, SDK, semaphore or permission-policy changes.

Residual acceptance work: the parent must rebuild only after this code handoff, then rerun the real Pi direct-session e2e and fresh full Electron/gate checks against the changed source. Full `pnpm typecheck` was not invoked because its Turbo prerequisite graph builds dependencies, including plugins; the 19 source typechecks were run using `--only` to preserve build immutability. The CLI sandbox cannot validate Electron/listener behavior. The attached-consumer unit reproduction establishes the ownership defect; actual post-fix real-Pi behavior still requires that e2e run. Reviewer gate remains required; no blockers identified in this bounded code review.

Final handoff: source edits and local proof are complete; all launched validation processes have ended. HEAD remains `ab77bdc2`, no staged files. Pre-existing `.jingler/e2e-full-batches.json` was left untouched. No rebuilt Electron artifact is claimed.
