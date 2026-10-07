# Phase3 integration result — reviewer gate remains required

No commit, stage, push, release, worktree transfer or wider-access request was made.

## Routine integration API

- Create with `SessionStore.create({ requestedSessionId, checkpointSafeMode: true, runtimeId: "pi", repoPath, repoName, projectId, providerId, modelId, connectionId, endpointId, baseBranch, mode, ... })`. Preserve the approved runtime/model/permission selection; never fall back. `requestedSessionId` remains the durable occurrence fence.
- New creations persist `checkpointExecutionHistory: "clean"`; legacy missing history remains unknown. Safe local isolated creation sets `workspaceLifecycle.status: "setup-skipped"` explicitly before any renderer terminal or first-turn handoff, and sets safe mode before returning. A configured project setup shell is rejected where its project service is available; routines must validate the current project before creation too. Direct/remote/native/Windows safe creation is refused.
- Desktop `Sessions.createWithProgress` runs the same creation path and initial `WorkspaceCheckpointService.setMode(sessionId, true)` capture before returning. Direct routine service creation should likewise run this service method before exposing/launching the session, after verifying that setup was explicitly skipped. Failure must record a failed occurrence, without launching.
- Existing workspace mode: `WorkspaceCheckpointService.setMode(sessionId, enabled)`. It verifies clean history, local isolated ownership, idle admission and managed Pi chats, captures before persisting enablement, and returns Session.
- Every actual `AgentRunner.prompt(sessionId, chatId, ...)` uses `acquireCheckpointedTurn(session, checkpointRoot, chatId)` before setup/provider launch. Do not add an alternate routine/native launch path. Requested inactive native chats are checked, and capture failure returns Failed with Retry guidance; no override.
- `WorkspaceCheckpointService.list/capture/preview/restore` and matching `WorkspaceCheckpoints.*` RPCs are wired. Restore takes the exact preview token. Restore never kills active work.
- `SessionStore.markCheckpointTerminalExecutionUnprovable` persists both generic taint and `checkpointPtyHistory: true` BEFORE PTY creation. A closed PTY leader does not release proof of ownership. Persisted PTY history refuses archive/delete, including after restart; ordinary terminals remain available when mode is OFF.
- `markCheckpointExecutionUnprovable` persists generic taint before ordinary unsupported turns and project commands. It prevents subsequent safe-mode enablement. Scheduled routine disclosures must state edit/inspect-only: no arbitrary shell/build/test, PTY, delegation, native harness, offload or external tools.

## Verification actually obtained

- 68 tests in 11 focused files pass: filesystem race sentinel, real Git/linked-worktree staging, capture gate, admission, safe tool registry, UI machine, raw port editor and approval-before-fetch helper.
- Session suite passed 84 tests; final rerun log is `/tmp/checkpoint-final-sessions.log`.
- Approved-copy subset passed 3 tests; 7 unrelated cases intentionally not selected. Full workflow file was attempted and cannot allocate loopback ports in this sandbox.
- CLI adapters, UI, core and contracts typechecks pass. Desktop typecheck fails on the existing six missing phase4 Routines handlers; no stubs were added.
- Changed-file Biome lint passes with warnings. Full repository gates remain the parent's responsibility.
- Built Electron checkpoint e2e was attempted, but plugin build failed first: tsx IPC `listen EPERM /tmp/tsx-501/*.pipe`. Electron never launched. The new e2e drives production Pi tools and the production capture gate, failure-before-provider, file/index restore, ignored secret exclusion and pinned backup UI; it is unverified.
- Official Electron utilityProcess docs and installed electron.d.ts were checked. Node24/Darwin worker behavior is exercised by real tests. This does NOT prove built Electron behavior.

## Required final review / residuals

- Rerun built Electron tests and full listener-dependent workflow/native-session tests outside this restricted CLI runner. No failures were reported as passes.
- The built-app e2e includes active-work/manual-restore refusal while its actual Pi response is held, in addition to admission/gate tests. This e2e has not launched in this sandbox.
- Cross-directory structured rename currently refuses explicitly because the worker's atomic rename supports one anchored parent only.
- Audit all direct SDK and renderer mutation routes before shipping; native runtimes, Pi gate, registry shell/external/delegation, PTY, Run/cleanup, direct editor/revert and publication are guarded, but this work is not an independent complete route certification.
- External editors cannot be locked. Restore revalidates after pinned backup and immediately before each target operation; a last external edit concurrent with atomic replacement is still possible. No path recheck is described as raceproof.
- Independent reviewer acceptance is still required. Phase4 prototypes remain intact and unfinished.
