# PR 311 adversarial review

- [x] Trace all eight findings and confirm failures.
- [x] Fix confirmed problems with focused regression tests.
- [x] Run relevant tests, typechecks, lint, and available security checks.
- [x] Review final diff and report each verdict without GitHub comments or merge.

## Verdicts

All eight findings are real. No finding was dismissed.

| # | Assessment and fix | Regression evidence |
| --- | --- | --- |
| 1 | Prefix matching trusted unrelated MCP tools. OpenCode now starts with an empty private home/config directory, disables project configuration, external plugins and external skills, and retains the original auth/session data directory. Discovery and execution share the same configuration. Residual remote/account/managed MCP configuration fails closed before provider/MCP initialization. Permission exemptions and hidden relay echoes use exact registry-derived tool names. | Read-only competing-prefix permission test, visible competing-prefix event test, residual configuration rejection, and a real OpenCode 1.18.14 test with hostile global/project/home configuration, an MCP startup command and a plugin. The live test also checks provider discovery, retained API-auth discovery and continuation across restart. |
| 2 | Progress rejection could be unhandled while execution continued; execution failure could publish ToolEnd before queued updates settled. Every queued publication now catches immediately, retains failure status, and drains before terminal publication on both paths. | Rejected publication with execution held across an event-loop boundary; registry failure while progress publication remains pending. |
| 3 | Text steering bypassed preparation. The turn driver now reports slash invocations and Ponytail deactivation as unsupported by raw steering, selecting the existing stop-and-replay path. Ordinary text still steers normally. | Turn-driver tests cover mode commands, managed skills, legacy skill syntax and deactivation. Existing portable-runtime tests cover preparation of replayed turns. |
| 4 | The portable parser rejected the existing /skill:<id> spelling. It now accepts that spelling, including Ponytail review mode activation. | Legacy /skill:ponytail-review expands across Pi, Claude, Codex and OpenCode while preserving injected policy. |
| 5 | String replacement interpreted operator-supplied replacement metacharacters. Replacement now uses a callback, preserving arguments literally. | Managed skill invocation containing $&, $`, $' and $$. |
| 6 | Imports could receive reserved IDs and then load bundled instructions instead. Import allocation now reserves built-in IDs. Existing collisions migrate to unused suffixed IDs and paths under the serialized catalog update; original files remain as rollback copies. | A newly imported explain skill and a legacy explain collision remain independently loadable with their original contents; migrated IDs persist. |
| 7 | Portable initialization ignored Pi's saved custom entries. On first use, a Pi continuation inside Jingler session storage supplies the latest valid ponytail-mode entry on its active branch. The new per-chat preferences take precedence thereafter. | A persisted Pi mode with an empty migration seed and no visible mode command survives; a subsequent explicit mode change remains authoritative across restart. |
| 8 | Vendor help described unsupported native plugin commands. Jingler now supplies its own help with portable slash commands, per-chat persistence and the Jingler update path. | Help expansion contains supported commands/update guidance and excludes @ponytail, /plugin and /reload-plugins. |

## Validation

- Core and CLI-adapters regression suite: 2,003 passed, 5 skipped before the final additional relay failure-path test.
- Real OpenCode 1.18.14 runtime suite: 26 passed, including hostile-configuration isolation and discovery/continuation checks.
- Final focused run across resources, OpenCode (including the real binary), relay, turn driver and Pi session factory: 70 passed. Package typecheck, lint and git diff --check reran successfully after the final test additions.
- Full workspace typecheck: passed using non-secret CI placeholders, a non-localhost auth URL and a 32+ character cron secret.
- Lint: passed with existing warnings. git diff --check: passed.
- Independent follow-up review: no issues found after aligning OpenCode discovery and execution. This is agent review, not human approval.
- Security scanners: semgrep, trivy and gitleaks are unavailable. No full Electron QA or live model-inference/auth-refresh test was run for these revisions.

## Deliberate compatibility limits and separate finding

Ambient custom OpenCode providers/plugins are not inherited. Discovery excludes those providers rather than advertising models that isolated execution cannot use. Existing built-in provider credentials and native session storage remain available; the live test verifies credential discovery, not successful inference or OAuth refresh.

Live validation also exposed an unrelated existing issue: OpenAI's model ID `o3` is rejected by ProviderModelId's three-character minimum. It predates these changes and is not changed here.

## Integration references

Installed versions checked: OpenCode CLI/SDK 1.18.14, Pi coding-agent 0.84.1, Ponytail 4.9.0.

- [OpenCode configuration precedence](https://opencode.ai/docs/config/#locations): configuration merges rather than replaces; a custom directory alone is not isolation.
- [Pinned OpenCode config loader](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/config/config.ts), [config paths](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/config/paths.ts), [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/effect/runtime-flags.ts), and [plugin loader](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/plugin/index.ts): verified project/home discovery and external-plugin/skill controls against the pinned source.
- [OpenCode authentication](https://opencode.ai/docs/cli/#login) and [pinned auth implementation](https://github.com/anomalyco/opencode/blob/v1.18.14/packages/opencode/src/auth/index.ts): auth remains in the original data directory.
- [Pi sessions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sessions.md): active-branch custom entries; API behavior checked against installed 0.84.1 SessionManager and Ponytail's installed resolveSessionMode implementation.

The operator subsequently authorized committing and pushing these fixes and monitoring PR #311. No GitHub comments or merge are authorized.
