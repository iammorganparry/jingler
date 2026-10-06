# Parent integration evidence

## Saved and integrated

- `af2242ff`: preserves partial checkpoint/routine prototypes after native worktree tools wrote into the source checkout. Those mutation lanes were interrupted; no draft is treated as complete.
- `16b05227`: preserves phase2 ports/previews and documentation after the external sandbox denied Git metadata writes.
- `ae1c04b0`: integrates the recovered phase1 safety patch; six merge conflicts resolved retaining both ownership and workspace environment behavior, plus both session test groups.
- `795e1925`: fixes the ports Electron spec's missing opening of the session composer before `addProject`.

## Parent checks actually run

1. `pnpm --filter @jingler/cli-adapters typecheck`: PASS after the combined safety/ports merge.
2. `pnpm vitest run packages/cli-adapters/src/workspace-ports.test.ts packages/cli-adapters/src/workspace-workflow.test.ts packages/cli-adapters/src/workspace-admission.test.ts packages/cli-adapters/src/child-registry.test.ts packages/cli-adapters/src/sessions.test.ts`: PASS, 117 tests in five files. All six port tests run in this host, including actual loopback listeners; no sandbox exclusion.
3. `pnpm --filter @jingler/desktop e2e workspace-workflow.spec.ts workspace-ports.spec.ts`: workflow PASS, ports FAIL because test never opened New session before registering a project. This was a test setup bug, not a networking assertion failure.
4. After one-line test correction, `pnpm --filter @jingler/desktop e2e workspace-ports.spec.ts`: PASS, real built Electron, two independent fixture servers, distinct embedded browser contents, readiness retry, stop/archive without cross-killing.

Logs: `/tmp/jingler-integrated-adapters-typecheck.log`, `/tmp/jingler-integrated-safety-ports-tests.log`, `/tmp/jingler-integrated-workflow-ports-e2e.log`, `/tmp/jingler-workspace-ports-e2e-retry.log`.

## Still required

Phase1 PTY/Pi descendant ownership and approved-copy ancestor races; all checkpoint review blockers and full production gate/UI; routines integration/UI/e2e; independent final reviews; full lint/typecheck/test/e2e. Happy paths above are not proof of race safety. No push or release.

Ports read-only review `a471555f` is BLOCK pending two P1 fixes: configured preview must require current workflow approval before any fetch/navigation; extra-port editor must keep raw text while typing and parse only on Save. Regressions requested for approval invalidation/fetch zero and character-by-character API=46000. Both assigned to sole writer `c1273c03`.

Operator decision `checkpoint-terminal-ownership-policy`: Accept v1 restriction. Checkpoint-safe mode is available only for workspaces without prior unprovable interactive PTY activity; existing terminal sessions remain normally usable, but need a fresh workspace for safe checkpoints. Block new interactive terminals in safe mode; persist taint before PTY creation so restart does not erase it. Never treat a closed leader as ownership cleanup.

Operator decision `checkpoint-safe-shell-policy`: Accept restricted v1. Safe-mode sessions and scheduled routines support structured file edits and supported read-only inspection, not arbitrary shell/build/test commands. Block unsupported terminals, delegation, offload and native harness routes; ordinary default-OFF sessions keep shell/parallel behavior. UI must disclose this restriction. Do not auto-change model, permission mode or claim rejected commands ran.

Current sole application writer: CLI fallback `1058e6a2-94d0-4266-92c0-2fb164820ec1`, intentionally current checkout. Native `c1273c03` was interrupted at its still-blocked supervisor wait; its partial files were preserved in `cf884a5e`. Fresh native fallback `fb321cdf` had only supervisor tools and was stopped without edits. No resumable retained child was reported. Use writing-capable CLI for generation, parent for sandbox-blocked real listener/Electron tests and Git commits. Ports reviewer `a471555f` completed with the two blockers above. Parent does not concurrently edit application code.

Filesystem research: current official Electron utilityProcess docs confirm cwd option and Node-enabled helper process: https://electronjs.org/docs/latest/api/utility-process . Installed Electron43.1.0 must still be checked against declarations. Directory-fd path traversal is not available on this Darwin Node24 host (measured); the cwd/inode-verified subprocess proposal remains unaccepted until behavioral race tests and built Electron validation prove it.
