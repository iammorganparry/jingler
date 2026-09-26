# Unified Jingler capabilities across native harnesses

## Goal and decisions

Jingler owns prompts/rules, portable skills (including Ponytail), configured MCP authentication/discovery, permission checks, and normalized tool events. Pi, Claude Code, Codex and OpenCode retain their own conversation loops. Switching harnesses must not remove a supported Jingler-managed skill or MCP service. Do not enable arbitrary local hooks/plugins to achieve parity.

Reuse the existing `AgentRuntimeShape`, `StreamEvent`, `ToolRegistry`, `AgentResourceService`, `PromptCompiler`, and registry-backed MCP relay. Do not introduce another skill/MCP subsystem. Pi-specific subagent/plan execution internals remain conditional; do not advertise unavailable tools in native prompts.

## Implementation checklist

- [x] Trace the four runtimes and research supported vendor integration points; verify current Claude tool round trips.
- [x] Share complete registry/prompt preparation and the authenticated MCP relay across native adapters; wire desktop and device registration through that preparation.
- [x] Make portable skills and Ponytail Jingler-owned, including command expansion and per-chat state that survives restart and harness changes; retain the same skill catalog in the composer.
- [x] Connect Codex and OpenCode to the shared capabilities, refresh them on resume, and prevent duplicate tool events or cross-chat credential/tool leakage.
- [x] Run parity, permissions, cancellation, concurrency, resume, prompt/skill, and tool-result regressions; typecheck, review security-sensitive changes, and report live verification limits.

## Concrete changes

### Shared preparation and relay

The full production registry factory currently lives in `runtime/agent/pi-runtime-live.ts`. It already loads authenticated MCP configurations, target-enabled managed resources, workspace tools, plugins, and mutation tracking. Claude reuses it; Codex/OpenCode are separately registered without it in desktop and device composition.

Expose/reuse this factory for all native registrations. Generalize `claude-cli-tool-relay.ts` only enough to expose a standard HTTP MCP attachment while retaining its existing role/mode filtering, permissions, output bounds, cancellation, mutation serialization, secret handling, and lifecycle events. Keep vendor config serialization in the respective adapters.

Compile core Jingler rules and the exact active catalog once per turn. Share that preparation rather than independently reconstructing prompts in each runtime. Keep unsupported Pi extension instructions out of native prompts.

### Portable skills and Ponytail

Keep managed resource authorization in `AgentResourceService` and the existing list/load tools. Move portable command preparation ahead of harness dispatch, so `/skill` invocation is consistent. Reuse Ponytail 4.9.0's installed shared instruction builder and skill files, not its native hooks or a copied ruleset. Use existing persisted chat/transcript data where sufficient; add minimal explicit chat state only if necessary for restart, mode/default changes, and harness switches. Pi must not inject a second conflicting Ponytail mode.

### Codex

Attach only the Jingler registry relay for Jingler-managed tools/services, rather than forwarding upstream MCP secrets/config independently. Inject compiled instructions through the generated protocol's supported instruction fields on both start and resume. Preserve existing unsupported permission-mode restrictions until tests prove an equivalent safe path; do not silently weaken approvals.

### OpenCode

Installed SDK/server target is 1.18.14. The SDK exposes MCP add by directory, not by session. Therefore use an owned per-run server for registry-backed execution, rather than adding run credentials to the existing shared discovery server. Session storage/resume remains native. Inject the shared prompt via the SDK system field and attach the Jingler relay inside that isolated server. Keep discovery pooling unchanged. Verify cleanup, concurrent same-directory chats, and resumed sessions with rotated relay credentials.

## Final verification

- Full regression run: 278 files passed; 2,868 tests passed; four opt-in live tests skipped. After the final small refactor, 106 focused tests passed, followed by 33 final fixture/state/event checks. Core, cli-adapters, desktop and device-agent typechecks passed. Changed-file Biome lint has no errors (warnings remain); `git diff --check` passed.
- All four live checks passed together on the final runtime code: native Claude, Claude via Pi sampling, native Codex, and native OpenCode. Versions: Claude Code 2.1.282; Codex 0.153.2; OpenCode/SDK 1.18.14; Pi 0.84.1; Ponytail 4.9.0. Codex used `gpt-6-astra`; OpenCode used `big-pickle`.
- Live testing found and fixed additional protocol issues: native tool aliases must be mapped explicitly; Codex's redundant MCP approval must be delegated only for Jingler's own permission-enforcing relay; OpenCode must generate its own sortable message IDs, otherwise it repeatedly answers the same turn. Regression coverage includes server-ID correlation, isolated concurrent chats, resumed credential refresh, and relay-event deduplication.
- Independent reviews found no blockers, including a follow-up on scoped Codex approval and OpenCode correlation. semgrep, trivy and gitleaks are unavailable; no scanner-clean claim is made. Validation ran on Node 22.14.0; the repository requests >=24.
- The exact supplied Claude transcript's continuation-text loop was not reproduced. The current native and sampling paths both passed tool/result round trips. No interactive desktop/browser QA was performed; verification covers normalized tool events and existing renderer/RPC tests.

Portable mode state is stored in the existing managed-resources directory as `portable-modes.json`, keyed by Jingler session/chat. Initial migration replays explicit mode commands from the visible transcript. Built-in skill descriptors now have one shared definition for the composer and agent catalog.

## Vendor references reviewed

- Claude headless execution: https://code.claude.com/docs/en/headless
- Claude flags: https://code.claude.com/docs/en/cli-reference
- Claude plugin behavior: https://code.claude.com/docs/en/plugins-reference
- Ponytail version-matched portability: https://github.com/DietrichGebert/ponytail/blob/v4.9.0/docs/agent-portability.md
- Ponytail version-matched Claude manifest: https://github.com/DietrichGebert/ponytail/blob/v4.9.0/.claude-plugin/plugin.json
- Codex app-server: https://learn.chatgpt.com/docs/app-server (matched to generated 0.153.2 protocol)
- Codex version-matched MCP approval configuration: https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/core/config.schema.json and https://developers.openai.com/codex/config-reference
- OpenCode SDK: https://opencode.ai/docs/sdk/ (public examples differ from v2; calls matched to installed 1.18.14 v2 types). Sortable-ID ordering context: https://github.com/anomalyco/opencode/issues/42608; the adapter fix uses server-generated IDs rather than reproducing the vendor algorithm.

## Estimate and scope

Original estimate: 120–180 minutes. Implementation and verification are complete. No new dependencies, no migration of Claude into Pi, no activation of arbitrary user/project plugins, and no claim of universal parity for harness-private features. Native server isolation adds process startup cost; only optimize sharing after safe concurrent execution is proven.
