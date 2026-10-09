# Conductor vs Jingler

## Recommendation
Build reusable workspace setup/run controls first, then port-aware preview and code restore points. Conductor's advantage in these areas is reducing repeated manual work around parallel agents, not agent count.

Research checked official Conductor docs and release notes against this checkout. Direct HTTP fetching was blocked by 403; web search returned indexed official content, including full scripts, environment-variable, cloud FAQ and API sections. No installed Conductor build was tested. Jingler findings are code-level, not a claim about what is enabled in production. Estimates below are rough engineer-hours, including focused tests and Electron e2e, not delivery commitments.

## Already covered / partly covered

| Area | Jingler evidence | Verdict |
|---|---|---|
| Parallel worktrees, agent controls and review | `packages/cli-adapters/src/sessions.ts`, `packages/core/src/runtime/subagent-fleet.ts`, `apps/desktop/src/renderer/conversation-pane.tsx`, `changes-review.tsx` | Already covers core parallel-agent workflow, diffs and inline comments. Do not duplicate. |
| PR workflow | `apps/desktop/src/renderer/pull-request-pane.tsx`, `use-pull-request.ts` | Create/publish/retry, merge, ready, update branch, submit review and resolve/reply to threads are wired. Exact Conductor Checks-tab parity remains unverified. |
| GitHub / Linear issue entry points | `plugins/linear/README.md`, `plugins/linear/src/manifest.ts`, `apps/desktop/e2e/linear-plugin.spec.ts` | Linear is shipped via official plugin, including issue-to-workspace and linking flows. Tests were inspected, not run. |
| Browser preview | `apps/desktop/src/renderer/preview-dock-view.tsx`, `apps/desktop/src/main/preview-view.ts`, `browser-control-port-live.ts` | Embedded browser and agent controls exist. Do not add another browser. Automatic run-to-preview setup is a separate gap. |
| Cloud / remote execution | `apps/managed-runtime/README.md`, `docs/remote-environments.md` | Managed sandbox/checkpoint code and paired-device execution exist. Production enablement not verified. Public automation API and multiplayer are not established by this audit. |

## Ranked additions

| Priority | Gap | Smallest useful addition | Rough effort |
|---|---|---|---|
| 1 — build first | Project workspace setup/run/cleanup hooks | Approved project commands, visible setup progress/failure/retry, named Run/Stop actions using existing terminal/process services, cleanup when archiving. Allow explicit copying of selected ignored local files; never silently copy secrets. Repository package scripts are not equivalent to these lifecycle controls. | 32–48 hours |
| 2 — next | Workspace port allocation and preview wiring | Persist a per-workspace port assignment, pass it to scripts/terminals/agents, and open a configured preview URL in the existing dock. Support extra service ports only as needed. Detect occupied ports; allocation alone cannot stop unrelated processes binding them. | 16–24 hours after #1 |
| 3 — next | User-facing code checkpoints | Capture working-tree state before an agent turn, show a diff before restore, and preserve the current state before overwriting. Include tracked and permitted untracked files; exclude ignored secrets/dependencies. Start with isolated local worktrees. File/line revert and publish retry checkpoints are not restore points. | 40–64 hours |
| 4 — later | Saved, externally triggered routines | A saved task plus authenticated trigger, fresh workspace, run history, cancellation and budget/permission limits. Reuse existing runtime/workflow/scheduling capabilities rather than introducing another runner. Public API and webhook ingress need a separate auth/security review. | 64–96 hours for one bounded trigger type |
| 5 — conditional | Main-checkout testing (Conductor Spotlight) | Explicitly sync one selected worktree into a clean root checkout for testing, preserving/restoring root state and blocking competing syncs. Only build if running separate Electron/native stacks is a real recurring problem. | 40–64 hours |

The first package (#1 + #2) is approximately **48–72 engineer-hours**. Run two workspaces from the same project and prove both set up, start on different ports, open the correct preview, stop, and clean up without cross-talk.

Live multiplayer is another documented Conductor capability. No shared live workspace/session UI was found in this focused Jingler audit. Defer it unless team collaboration is a product goal: authorization, simultaneous edits/prompts and shared secrets make this much larger than feature parity. A defensible estimate needs a dedicated design pass.

## What not to copy

Keep Jingler's existing agent fleet, review, browser and issue integrations. Don't rebuild them to match Conductor labels. Don't replace Plannotator's lifecycle with a second plan system. New code checkpoints must be clearly separate from plan state, publication retries and cloud sleep/recovery checkpoints.

## Official sources

| Source | What it establishes |
|---|---|
| [Project scripts](https://www.conductor.build/docs/reference/scripts) and [configure your project](https://www.conductor.build/docs/configure-your-project) | Setup/run/archive hooks, named commands, concurrent/nonconcurrent mode and explicit ignored-file copying. |
| [Environment variables](https://www.conductor.build/docs/reference/environment-variables) | Local workspace range of ten ports; `CONDUCTOR_PORT` is not available in cloud workspaces. |
| [Checkpoints](https://www.conductor.build/docs/reference/checkpoints) | Local code snapshots separate from branch history, captured before supported agents respond. |
| [Testing](https://www.conductor.build/docs/concepts/testing) and [Spotlight](https://www.conductor.build/docs/reference/scripts/spotlight-testing) | Isolated workspace runs versus root-checkout testing. |
| [API](https://www.conductor.build/docs/api) and [Cloud FAQ](https://www.conductor.build/docs/cloud/faq) | Beta workspace/session API, webhook routines; cloud execution and live collaboration. Mobile is described as coming soon, not counted as shipped. |

Additional parity sources: [first workspace](https://www.conductor.build/docs/first-workspace), [issue to PR](https://www.conductor.build/docs/guides/issue-to-pr), [agent modes](https://www.conductor.build/docs/concepts/agent-modes), [PR-page release](https://www.conductor.build/changelog/0.73.0-pr-page), [browser-preview release](https://www.conductor.build/changelog/0.62.0-repo-settings-browser-preview). Release entries prove a feature announcement, not latest-build behavior.

## Verification
Read official indexed documentation; inspected Jingler renderer, services, plugin manifest and existing e2e source; performed focused repository searches for lifecycle scripts, port allocation and Spotlight. Corrected the scout's initial Linear and package-script classification. No application code changed; no tests run for this research-only task.
