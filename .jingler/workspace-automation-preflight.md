# Workspace automation preflight

## Phase 1

Parent checked current official Effect 3 command docs and XState 5 actor docs before implementation:
- https://effect.website/docs/platform/command/
- https://effect.website/docs/v3/api/platform/CommandExecutor
- https://effect.website/docs/v3/api/platform/Command
- https://stately.ai/docs/invoke
- https://stately.ai/docs/promise-actors
- https://nodejs.org/docs/latest-v24.x/api/child_process.html

Manifest versions: Effect ^3.21.4, @effect/platform ^0.96.2, @effect/platform-node ^0.107.0, XState ^5.32.4, Electron 43.1.0. Shell Node v24.19.0. Installed signatures must still be verified by each implementation pass. Available security scanner check: semgrep/trivy/gitleaks all unavailable. Use tests and explicit security review; do not claim a scanner passed.

## Phase 2

Installed Codex: 0.160.0; Jingler vendored protocol constant: 0.153.2. Do not overwrite generated protocol files or assume all latest config keys are supported by the vendored version.

Official guides researched:
- https://developers.openai.com/codex/app-server.md — stdio JSONL app-server; schemas can be generated from a particular installed CLI version; thread/start supports config overrides.
- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/config-reference — currently redirects to https://learn.chatgpt.com/docs/config-file/config-reference.md; the redirected official Markdown was read directly.

Current reference: `shell_environment_policy.set` is a map<string,string>; injected after exclusions but include filters may still remove entries. Current `filters` map replaces legacy `exclude`/`include_only`, but do not adopt newer filter syntax unless supported by the targeted protocol/CLI. Preserve operator environment restrictions and verify actual shell execution instead of assuming spawn environment inheritance is enough.

Repository evidence: ThreadStartParams has a typed JsonValue config map; TurnStartParams does not expose arbitrary per-turn config. CodexClient starts one owned server per run/probe, accepts environment, sanitizes it through nativeCliEnvironment, and only re-adds explicit mcpEnvironmentKeys. Port variables need a separate trusted attachment path; do not misuse MCP credential transport. Pi workspace-mutation-tools.execute currently starts a shell without explicit Command.env. Both require tested per-session transport, never global process.env mutation.

A research child lacked tools and was stopped; no unverified child findings are used.

## Phase 3

Installed Git: 2.39.3 (Apple Git-146). Official search-indexed docs read:
- https://git-scm.com/docs/git-rev-parse
- https://git-scm.com/docs/git-write-tree
- https://git-scm.com/docs/git/2.48.0 (not a version-match; use local 2.39.3 behavior tests)

Direct Git website requests returned 403. `write-tree` uses the index and requires a fully merged index; one worktree tree alone does not preserve staging. `runtime/file-changes/file-change-tracker.ts` already creates a temporary GIT_INDEX_FILE and captures a tree without touching the real index. Reuse its approach/helper only where appropriate; it is transient, contains no separate staged tree, and is not durable user recovery.

Review requirements: resolve Git dirs through Git; private refs namespaced by repository/session/checkpoint; separate index and worktree state; HEAD-drift refusal; exact restore manifest; ignored-file collision refusal; backups survive worktree deletion; all mutation admission paths share a lock. No checkpoint implementation has started yet. The parallel read-only lane returned an untested capture patch; it is NOT accepted for direct application. Parent inspection found a nested `Effect.runPromise` with an unresolved CommandExecutor requirement and an empty `GIT_INDEX_FILE` override that must be verified/corrected, plus missing storage/file-count limits. Reuse ideas only after compilation and real linked-worktree tests.

## Parallel patch artifacts (not shipped code)

Checkpoint proposal: `/var/folders/8n/3c40dztn2mv0_mm503y5fxsh0000gn/T/pi-subagents-uid-501/async-subagent-runs/4a54bf1c-b215-4fcb-882d-9ab5c7f05b49/external-0.final-message.txt`.

Routine scheduling proposal: `/var/folders/8n/3c40dztn2mv0_mm503y5fxsh0000gn/T/pi-subagents-uid-501/async-subagent-runs/86134675-08d8-467b-93c3-0a4307e4ab60/external-0.final-message.txt`. Pure draft; persistence, limits, UI and actual scheduler are still unimplemented. Generated tests were not run. Validate disabled/ready cancellation slot handling and decoded occurrence cursor integrity during integration.

Initial ports lane failed due to external runner parser line-size limit; bounded retry run `9269046a-22d4-4107-aac1-460dc386c9a2` completed with an untested allocator + unit-test proposal. It probes both IPv4/IPv6 loopback, excludes archived assignments and requires the caller-held store lock. Integration must also test simultaneous store calls, IPv6 listener conflicts, trusted environment propagation, session-source coverage and Electron e2e. No phase2 code has been applied yet. Phase1 writer remains the sole application-code writer. Read-only security review run `9d271f7b-9faf-48ed-943d-d120e1772ba6` completed BLOCK. Required fixes relayed to the writer: setup/cleanup internal owner must operate while public admission is closed; safe destination open must not follow symlinks (and parent mkdir must validate containment before writes); owned process group termination must finish before lifecycle activity is released; reopen must match the closure operation token so setup/skip cannot erase archive/delete admission. Parent also found startRun can report ghost running state when admission/spawn fails before registration, and `.git` path protection needs case-insensitive handling on supported filesystems. Add regression tests before any phase1 completion claim.
