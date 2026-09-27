# Shared harness planning tools

Approved approach: Jingler owns planning tools and behavior across Pi, Claude, Codex, and OpenCode. Preserve permissions and operator review; audit other Pi-only tool gaps without promising unsupported capabilities.

- [x] Trace planning lifecycle, UI events, and other Pi-only tools; research installed integration versions and current vendor guidance.

Research: installed Claude 2.1.282, Codex 0.153.2, OpenCode SDK/CLI 1.18.14, Pi 0.84.1, pi-subagents 0.65.0, electron-vite 5.0.0. Read official MCP guidance at https://code.claude.com/docs/en/mcp, https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli), https://opencode.ai/docs/mcp-servers/ and version-matched OpenCode MCP source https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/mcp/index.ts. Codex defaults tools to 60 seconds; owned relay timeouts must allow operator review. Electron bundling guidance: https://electron-vite.org/guide/migration.

Audit: questions, explanation, completion, workspace/code tools, resources, configured MCPs already use the shared registry. Planning bypassed it as a Pi extension; this work moves ownership into Jingler. Child delegation/supervision remain Pi-only; implementing an entire cross-harness child backend is not part of this planning fix. Corrected advertised wait tool to installed `bg_wait`.

Validation: fixed the initial review findings (original Pi child ceiling, authoritative shared recovery state, child/parent mutation serialization). Fixed desktop startup bundling and preserved invalid-file recovery/progress behavior. `pnpm exec vitest run`: 455 files passed, 4,434 tests passed, 5 opt-in tests skipped. Desktop `plan-mode.spec.ts` and `plan-tools-any-mode.spec.ts`: all 11 passed. Native fixture transports verify Claude/Codex/OpenCode submit/update calls, pending UI approval, returned verdicts, tool events, and inherited prompt rules. CLI-adapters and desktop typechecks pass. Biome error gate and complexity lint pass (existing warnings remain). Final independent review found no remaining blockers; prior permission, recovery, and serialization findings are resolved.

Limits: Node 22.14.0 in this environment despite repository Node >=24 requirement. No new live model planning run, no full Electron suite, no security scanners installed. Changes remain uncommitted and unpushed; no GitHub actions.
- [x] Implement shared planning tools and route all harnesses through the same behavior.
- [x] Add regression tests for tool availability, plan view/progress, review decisions, and permissions.
- [x] Run focused checks and report remaining parity gaps and validation limits.

## PR publication

- [x] Commit the planning changes on a fresh branch based on current main.
- [x] Run post-rebase validation and push the branch.
- [x] Create the pull request with verification results and limitations.

Published https://github.com/iammorganparry/jingler/pull/315 from `fix/shared-harness-planning`. PR #311 was already merged. Post-rebase verification: 1,585 cli-adapters/plannotator tests passed, 5 opt-in tests skipped; CLI-adapters and desktop typechecks, Biome error gate, and diff checks passed. Earlier workspace/Electron results above predate cleanup/rebase. No merge performed.

## Review cleanup

- [x] Remove orphaned Pi planning subscription/phase hooks and obsolete extension-specific tests; shared planning behavior tests remain.
- [x] Import the bundled planning config directly in its test; remove the runtime-only path resolver.
- [x] Remove the unused harness argument from shared role policies and collapse the now-identical parameterized prompt test.
- [x] Verify cleanup: 54 focused tests passed, 2 opt-in live tests skipped; CLI-adapters typecheck, changed-file Biome check, and `git diff --check` passed. No commit or push.
