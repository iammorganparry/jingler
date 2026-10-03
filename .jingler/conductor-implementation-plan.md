# Workspace automation implementation plan

Status: operator authorized implementation with “Lets implement”. Review completed with blocking design findings; the mandatory corrections below are part of implementation. Implement phases 1–4; do not release or publish. Earlier effort figures remain provisional until Git/process/environment feasibility tests pass.

## Scope and decisions

Implement comparison items 1–4 in order: approved project setup/run/cleanup; local workspace ports and preview; code restore points; saved desktop routines.

The operator selected **this desktop** and **scheduled triggers**, with manual Run now. They also selected **opt-in checkpoint-safe mode**: normal workspaces retain current parallel behavior by default; enabling safe mode requires quiescence and blocks unsupported overlapping/delegated execution only in that mode. Scheduled routines use safe mode. No webhook server, cloud routine runner, main-checkout testing or multiplayer. Workspace features start with isolated local worktrees; unsupported remote/direct actions must be disabled explicitly, never executed locally as a fallback.

Proposed safe schedule defaults for review: no catch-up while Jingler is closed; skip overlapping runs; retain missed/skipped history. No background daemon. Closing Jingler stops its runs; a restart marks unfinished runs interrupted rather than restarting them invisibly.

## Planning progress
- [x] Confirm feature scope and routine execution/trigger choices.
- [x] Trace implementation points and reusable scheduler/process/Git services.
- [x] Specify phases, acceptance tests, safety rules and estimates.
- [x] Consume independent review and operator implementation authorization.

## Mandatory review corrections

These replace any less precise statements below. Resolve them in tested code before dependent phases.

### Phase 1: admission and owned processes
Reuse `child-registry.ts`, adding session/action ownership and awaitable process-tree termination rather than another registry. Archive/delete first close workspace admission to new agent turns, delegated/background jobs, terminals and Run actions, then await owned agent/PTY/command shutdown, then cleanup, then persistence/removal. Reopen admission only after a failed operation is safely recovered. Direct local create/agent calls must not bypass setup readiness. Persist setup/cleanup status and reconcile interrupted operations on boot; never automatically retry commands or kill stored PIDs without verifiable live ownership. Cover grandchildren, shutdown timeout, crash-surviving processes, interrupted setup/cleanup and archive/delete/start races. Unsupported process ownership on a platform must fail explicitly rather than falsely report Stop succeeded.

### Phase 2: actual process environment
Include `runtime/tools/workspace-mutation-tools.ts` command execution, `runtime/providers/native-cli-environment.ts` allowlist and `runtime/codex/client.ts`, as well as PTY, native shell and child-agent spawn paths. Pass trusted session env explicitly without mutating `process.env`. Test distinct concurrent Pi/Codex/child command values. Configured commands receive the assigned port; arbitrary applications can override env internally, so do not promise universal `.env` precedence.

### Phase 3: precise Git recovery
Audit `runtime/file-changes/file-change-tracker.ts` shadow-index code first. Use a temporary `GIT_INDEX_FILE`; resolve index/common Git directories through Git, never `.git/index`. Namespace private refs by repository/session/checkpoint. Store separate HEAD identity, index tree and worktree tree/file manifest. Reject unsupported/conflicted index states and HEAD drift. The restore preview names every create/overwrite/delete. Files created after the checkpoint and ignored-file collisions must never be silently destroyed: preserve them or block for operator resolution; re-check current ignore policy against older snapshot entries. Preserve failed-restore backups outside a deletable worktree with owner-only access, including retention/deletion paths. Tests prove staged/unstaged recovery and ignored collisions do not lose data.

Name one workspace admission coordinator and verify every entrypoint: `AgentRunner.prompt` (concurrent chats), `native-external-job-provider.ts` direct runtime launches, Pi children, local agent tools, routine launches and Run/terminal creation. Restore closes admission and waits for all known work to quiesce under that coordinator; a single-chat idle check is insufficient. Explicitly refuse unsupported delegated paths rather than claim checkpoint safety. Test admission-versus-restore races. External editors cannot be locked by Jingler; revalidate the preview and report that limitation.

### Phase 4: durable run identity
Build the small desktop scheduler directly; no speculative dependency reuse. Atomically persist each occurrence claim with a stable requested session ID before workspace creation, pass `requestedSessionId` into the existing session creation path, and reconcile that exact ID after restart without redispatch. Fault-inject before/after workspace creation, run linking and final history writes. No exactly-once guarantee for external effects.

The authorized draft's safe v1 policies remain: one-time/fixed-interval schedules, no catch-up, skip overlapping runs and one active routine globally. Show these limitations in the UI; calendar recurrence/timezone-DST behavior stays out of scope unless requested.

## Phase 1 — Project setup, Run/Stop and cleanup

> complexity: medium-high

### Tasks
- [ ] Add optional typed project workflow settings and run state, then RPC contracts before handlers and renderer. Existing projects/sessions must decode unchanged; project re-registration and settings saves must preserve unrelated fields.
- [ ] Let the operator configure setup, named run commands and cleanup in project settings. Store machine-local approved configuration using the existing project store first; defer repository-shared import until there is a clear trust/approval flow.
- [ ] Require explicit approval for commands and selected local-file copies. Approval binds to project and configuration content; an agent editing repository files cannot silently authorize commands. Changed configuration invalidates approval. Never put credentials in RPC responses, settings exports or transcripts.
- [ ] For a fresh local worktree, copy only explicitly selected relative local files, then run setup. Validate real paths, reject traversal and escaping symlinks, protect `.git`, and never copy broad secret patterns automatically. Show setup output/status and Retry; block the initial agent task until setup succeeds or the operator explicitly skips it.
- [ ] Add named Run/Stop actions and bounded output using existing process/terminal facilities. Repeated Run must not accidentally duplicate the same command. Stop must terminate owned child processes, not unrelated sessions; enforce timeouts for setup/cleanup and bounded logs.
- [ ] On archive: stop owned run processes, run approved cleanup, then archive. A cleanup failure stays visible and allows Retry or explicit Archive anyway; do not delete the checkout. Restore does not automatically re-run setup or commands. Delete and app quit also clean up owned processes without allowing quit to hang indefinitely.

### Files / reuse

`packages/core/src/domain.ts` (`Project`, `Session`); `packages/contracts/src/index.ts` (`Projects.*`, terminal/session RPC groups); `packages/cli-adapters/src/projects.ts` (`ProjectService` atomic store); `sessions.ts`; `terminal.ts` (`TerminalService`); `command.ts`; `worktree-env.ts`; `apps/desktop/src/main/rpc.ts` and `runtime.ts`; renderer `use-projects.ts`, `use-terminals.ts`, `App.tsx`, project/settings UI. Setup inserts in the local `SessionStore.create*` paths after worktree creation, before initial task readiness; all creation sources (new task, existing branch, PR, issue and routine) must use it.

Use one small Effect service for project command lifecycle only if existing terminal/process ownership cannot cover it. Do not implement reliable command execution by typing strings into an interactive terminal. Model related renderer setup/run modes in XState rather than scattered setters; share the host run status instead of inventing a second persisted UI state.

### Acceptance

Unit/service tests cover approval invalidation, legacy settings, safe file copying, setup failure/retry, process tree termination and cleanup failure. Add `apps/desktop/e2e/workspace-workflow.spec.ts`: configure a project, create a worktree, verify setup and copied file, run/stop a command, archive with cleanup, retry failure and restore without surprise execution.

## Phase 2 — Workspace ports and preview

> depends: Phase 1
> complexity: medium

### Tasks
- [ ] Persist a local port allocation per workspace, allocated under the existing store lock and checked against active allocations and listening sockets. Start with one app port plus explicitly requested additional service ports; no networking dependency or proxy.
- [ ] Pass trusted `JINGLER_PORT`, configured additional port values, `JINGLER_WORKSPACE_PATH` and `JINGLER_ROOT_PATH` through one shared environment helper into setup/run commands, interactive terminals and agent-launched commands. `CreateTerminalInput` and `AgentTurnSpec` currently lack a generic session environment: extend them and the Pi/Codex tool/spawn paths rather than putting variables only in prompt text. Never mutate global `process.env`, which would mix concurrent sessions. Keep `worktreeEnv` sanitization; disable compute offload for local app servers and keep port-dependent execution local.
- [ ] Configure a preview URL template in project settings and resolve it from the allocation. Open it through the existing dock only on operator intent; readiness failures must show an error/retry, not a blank success. Restrict templates to valid HTTP(S) URLs and never interpolate arbitrary shell text.
- [ ] Preserve ports across restart when available. If another process takes an assigned port, report the conflict and offer explicit reassignment; do not kill it or change a live server's environment. Archive keeps the assignment for restore; deletion releases it after owned processes stop. Configured commands receive the port explicitly; applications may still override their configuration internally, which Jingler cannot prevent.

### Files / reuse

`domain.ts`, `projects.ts`, `sessions.ts`, `worktree-env.ts`, `terminal.ts`, local command/agent execution entrypoints, `execution-router.ts`; `preview-dock-machine.ts`, `use-preview-dock.ts`, `preview-dock-view.tsx`, `apps/desktop/src/main/preview-view.ts`. Existing browser renderer and native controls remain unchanged unless required for the Open preview action.

### Acceptance

Unit tests cover simultaneous allocation, occupied ports, restart/reassignment, deletion and environment propagation. Add `apps/desktop/e2e/workspace-ports.spec.ts`: run two workspace servers concurrently, verify distinct ports and preview contents, stop/archive one and prove the other stays up. Prefer a tiny repo fixture server over a production app launch for deterministic behavior.

## Phase 3 — Code checkpoints and restore

> depends: Phase 1 local setup readiness; may follow Phase 2 for simpler delivery
> complexity: high; data-loss-sensitive

### Tasks
- [ ] Trace `Agent.run` in main `rpc.ts` through `routeSessionOperation`, `AgentRunner` and `runtime/agent/pi-session-factory.ts`; capture at a shared service-level local turn-start path before any mutating tool runs. The renderer is not the checkpoint owner. Routines must use this same path. For parallel agents sharing a worktree, capture only at a quiescent point and label the checkpoint workspace-wide, not as undo of one child. Isolated child worktrees require their own supported ownership/capture path; do not claim universal child coverage without tests. Keep this separate from Plannotator, cloud workspace checkpoints and publication retry records.
- [ ] Use the existing Git service/helpers and private refs/objects where practical. Do not move the branch, write a visible commit or alter the user's index merely to capture a snapshot. Capture tracked files, permitted nonignored untracked files, deletions, binary contents and executable bits; preserve staged versus unstaged state or explicitly block restoration when it cannot be preserved safely.
- [ ] Reject unsafe paths and avoid traversing symlinks. Never capture ignored local secrets, dependency/cache directories or external submodule contents. Record checkpoint HEAD identity and refuse restore across an unexpected HEAD/branch change until an explicit safe policy exists. Unsupported repositories, conflicts or nested/submodule state must get a clear refusal, not partial restore. Define bounded retention and storage limits, with pinning of the latest pre-restore backup and owner-only filesystem access. If checkpoint capture fails before a turn, block automatic execution and offer Retry or an explicit Continue without checkpoint; unattended routines fail visibly instead.
- [ ] Add checkpoint list and diff preview using existing changed-files/review UI. Restore requires confirmation, a stopped/quiescent workspace (including agents and owned app processes), and an exclusive host workspace mutation lock. Revalidate immediately before restore so a stale diff cannot overwrite newer work unnoticed.
- [ ] Before restore, create a safety checkpoint of the current state; if capture fails, make no changes. Use an explicit file manifest, not `git clean -fdx` or wholesale destructive reset. Leave ignored/unrelated files untouched; ensure restored/deleted files match the selected snapshot. Record failures and offer recovery from the safety backup.
- [ ] Keep restore local-worktree-only for v1; direct checkout/remote buttons explain why unavailable. Cleanup of old refs and session deletion must not remove a still-needed recovery backup during a failed restore.

### Files / reuse

`packages/cli-adapters/src/git.ts`, `command.ts` (`runGitRaw` for NUL-delimited paths), `sessions.ts`, agent turn entrypoints and `execution-router.ts`; core and contracts; renderer `changes-review.tsx`, review diff hooks and conversation controls. Prefer a focused checkpoint module using existing Git helpers, not a general version-control framework.

### Acceptance

Real temporary Git repository tests cover staged/unstaged files, renamed/deleted/binary/executable files, permitted untracked files, ignored secrets, symlink escape, corrupt snapshot, storage failure, dirty-index preservation, stale preview and concurrent writes. Add `apps/desktop/e2e/workspace-checkpoints.spec.ts`: agent makes two edits, preview an earlier checkpoint, restore it, verify files, then recover the pre-restore state. Test restore refusal while a turn runs. No data-loss scenario is waved through as a warning.

## Phase 4 — Saved desktop routines and schedules

> depends: Phases 1–3
> complexity: medium-high; unattended execution

### Tasks
- [ ] Add typed durable routine definitions and run records: local project, prompt, explicit agent/model/permission settings, schedule, enabled flag, limits, timestamps and linked workspace/session. Persist under `JINGLER_HOME` with existing atomic JSON patterns. Do not persist credentials or executable workflow JavaScript generated from prompt text.
- [ ] Provide create/edit/enable/disable/delete, next-run display, Run now, cancellation and run history. Each run creates a fresh local worktree through the same setup, port and checkpoint flow; routines never operate directly on the user's root checkout.
- [ ] Add a small main-process scheduler with one next-due timer and an injected clock, calling the existing session/agent runner. The code audit found no app-owned durable routine scheduler: native subagent supervision controls task lifecycles, managed `execution-scheduler.ts` serializes commands, and server cron maintains GitHub outbox delivery. None is a desktop routine store. Before implementation, check installed pi-subagents `0.65.0` scheduling exports once; reuse only if they cover these durable app-owned semantics without a transient chat dependency. Do not create a parallel agent executor.
- [ ] Ship one-time and fixed-interval schedules first using explicit timestamps/intervals, with human-readable next-run times. Defer cron and daily wall-clock recurrence unless required; those introduce timezone/DST policy. Reconcile startup and sleep/wake from durable timestamps, not long in-memory timers alone.
- [ ] Proposed defaults: skip missed occurrences and overlaps; one scheduled/manual routine run active across the desktop for v1 (ordinary interactive agents remain independent). Atomically claim each occurrence with a reserved session ID before starting a workspace; pass `requestedSessionId` during creation and reconcile that ID after a crash. Restart must not launch the same occurrence again. Unfinished runs become interrupted and remain visible; no exactly-once claim about external side effects.
- [ ] Saved permissions never escalate on unattended launch. Require explicit enablement/approval, default to review-safe settings, surface approval requests as needs-attention, and enforce max duration and supported usage limits. If a strict cost cap is not enforceable for a harness, don't promise it: require an enforceable runtime limit and display actual available usage metrics.
- [ ] Revalidate project/config approval, credential availability, Git status requirements and model support on each run. Missing prerequisites fail visibly; never choose another model, environment or permissive mode silently. Skip rather than launch after disable/delete races. Do not auto-merge or auto-delete failed run workspaces.

### Files / reuse

Core/contracts, `AppPaths` and desktop `app-paths.ts`; `ProjectService`, session creation and `AgentRunner`; app main boot/quit handling; renderer routines XState machine/hook and existing workspace/transcript navigation. Manifest-pinned `pi-subagents` version is `0.65.0`; no durable app routine scheduler was found in the repository. No server API or relay changes expected for this operator-selected scope.

### Acceptance

Fake-clock tests cover long delays, invalid intervals, suspend/resume, missed/overlapping runs, disabled/edit/delete races, persistent occurrence claims, cancellation and restart recovery. Add `apps/desktop/e2e/desktop-routines.spec.ts`: create a routine, Run now into a fresh worktree, inspect history/transcript, run a short test-only schedule, disable it and verify no new work, restart and verify no replay of an already claimed occurrence.

## Implementation results (in progress)

Phase 1 writer reports 32 focused tests, affected typechecks and built Electron `workspace-workflow.spec.ts` passed. These prove the happy workflow, not full safety acceptance. Parent reinspection still requires no-follow destination copying, truly exclusive lifecycle ownership/token validation, bounded process-group wait including an already-exited leader, and retaining activity until the group is stopped. Fixes and regression tests are pending; phase 1 is NOT complete.

Read-only workers returned untested proposals for port allocation, Git checkpoint capture and scheduling logic. They are NOT applied or shipped. Candidate artifact references and parent caveats are in `.jingler/workspace-automation-preflight.md`.

Saved WIP foundation in local commit `9f66f87d` (not pushed/released) to enable clean managed worktrees. Four independent mutation lanes are now running: phase1 safety and phase2 ports via codex-exec-writer after native launch timeout, phase3 checkpoints and phase4 routines via native worker. Parent will integrate verified lane commits in dependency order, resolve shared-file conflicts, then run full gates. Mission `97e6ba17-f6d3-4d4b-803f-cbf002b9b607` keeps completion active. No phase is considered complete yet.

## Delivery and verification

| Phase | Rough engineer-hours including focused tests and e2e |
|---|---|
| 1: workflow commands and settings | 32–48 |
| 2: ports and preview | 16–24 |
| 3: checkpoints and safe restore | 40–64 |
| 4: desktop schedules and routines | 32–48, subject to scheduler audit |
| Total | 120–184 hours; around 15–23 eight-hour engineer-days |

Deliver four reviewable changes in dependency order, each with a user-facing changeset. Parent verifies delegated work; one writer per checkout. Re-estimate after the phase 1 process-lifecycle and phase 3 Git spike; those carry the most risk. No release workflow is triggered by this plan.

For each phase, run focused service/machine tests and the new built-app Electron spec. Before merging, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter @jingler/desktop e2e`. Run available security scanners for command approval, filesystem copying, snapshot restoration and unattended execution changes. Manually QA controls, theme tokens, keyboard access and status/error text. Record exact commands/results and remaining limitations rather than calling unrun checks green.

## Sources and implementation preflight

Conductor references: [scripts](https://www.conductor.build/docs/reference/scripts), [workspace variables](https://www.conductor.build/docs/reference/environment-variables), [checkpoints](https://www.conductor.build/docs/reference/checkpoints), [API/routines](https://www.conductor.build/docs/api). Conductor behavior is inspiration, not a required SDK integration; we are not calling its API.

Manifest versions checked: Electron `43.1.0`, XState `^5.32.4`, Effect `^3.21.4`, pi-subagents `0.65.0`; shell Node is `v24.19.0`. Before writing new framework/process calls, confirm resolved versions and Electron's embedded Node, and read matching official docs. Node 24 process guidance checked: [child processes](https://nodejs.org/docs/latest-v24.x/api/child_process.html). Shell-child cancellation must not be assumed to terminate descendants. Planning changes only; no app code or tests run yet.
