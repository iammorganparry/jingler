# Claude Code runtime contract

- [ ] Trace both Claude entry points, prompt compilation, tool execution, and UI event consumption; reproduce the missing-result failure.
- [ ] Use the existing Jingler runtime/event contract for Claude output and preserve tool names, arguments, results, errors, and cancellation without duplicate execution.
- [ ] Pass the compiled Jingler prompt/rules and active tool catalog to Claude; retain Jingler permission enforcement and subscription authentication.
- [ ] Add and run regression tests for shell output, tool rendering events, prompt inheritance, repeated turns, and failures; run security checks for relay changes.
- [ ] Report verified behavior, current vendor references, and any live-test limitations.

## Updated operator requirements

Jingler owns a unified skill and MCP experience across harnesses. Portable capabilities (including Ponytail) must be exposed through Jingler-managed catalogs, state, and execution rather than each harness's private plugin installation. Truly harness-specific features remain conditional. Keep native harness loops; do not migrate Claude to Pi just to inherit extensions.

Research confirmed Ponytail 4.9.0 supports Claude, Pi, Codex, and OpenCode. Its npm package includes shared instructions/skills but omits the native Claude plugin manifest. Its native hooks use a shared mode file, unsuitable for isolated Jingler chat state without additional work. Reuse shared instructions and let Jingler own state. References: https://github.com/DietrichGebert/ponytail/blob/v4.9.0/docs/agent-portability.md and https://code.claude.com/docs/en/plugins-reference.

Before expanding implementation, trace shared skills/MCP preparation and prompt compilation across all four runtimes, then submit the revised cross-harness plan for review. Current runtime changes are partial, not ready to claim complete.

## Observed progress

- Baseline: 33 existing Claude tests passed.
- Fixed native launch's --safe-mode conflict with MCP, added compiled core prompt, and forwarded command targets/progress using the existing event contract.
- Live Claude 2.1.282 testing exposed rejection of rate_limit_event; accepted that metadata record.
- Live native supplied-tool/result check passed; live Pi sampling-provider two-turn tool/result check passed.
- Focused deterministic run: 49 passed, one opt-in live test skipped. Latest typecheck identified a test observer fixture type issue; fixture corrected, rerun pending.
- The exact supplied transcript's repeated continuation-text failure has not been reproduced.

## Findings before implementation

There are two paths: `claude-cli-provider.ts` exposes a Pi sampling provider and stops Claude after capturing one MCP call; `claude-agent-runtime.ts` runs Claude as a native agent and executes tools through the registry relay. Both have separate stream decoders. The native runtime currently supplies no compiled Jingler system prompt. Its relay publishes ToolStart with no target and does not forward tool updates. The supplied transcript's exact failure has not yet been reproduced.

Reuse `AgentRuntimeShape`, `StreamEvent`, the existing prompt compiler, and registry execution rather than introducing a third interface. Trace endpoint ownership before deciding whether the legacy sampling path can be removed safely.

Installed Claude CLI: 2.1.282. MCP SDK declared: ^1.29.0. Pi packages: 0.84.1. No Anthropic Agent SDK dependency in cli-adapters; integration uses the CLI JSONL protocol.

Vendor reference: https://code.claude.com/docs/en/headless (reviewed). Do not switch subscription sessions to --bare: current docs say that mode does not read subscription OAuth credentials.
