# Claude CLI provider relay

## Goal

Run Claude subscription inference through the locally authenticated Claude Code CLI while retaining Pi as Jingler's agent loop, so existing normalized tools, permissions, Plannotator, subagents, sessions, steering, and events keep working unchanged.

## Steps

- [x] Trace runtime construction, Pi's custom provider contract, tool registry creation, and Claude CLI stream contracts.
- [x] Add a Claude CLI `streamSimple` provider that serializes Pi context and strictly decodes Claude stream events.
- [x] Add a per-request loopback MCP relay that turns Claude tool selections into Pi tool-call stream events without executing them twice.
- [x] Install the relay only for locally verified Claude subscription connections and fail closed when CLI auth or billing-route checks fail.
- [x] Add focused unit tests and Electron onboarding e2e coverage.
- [x] Run targeted tests, typecheck, lint, full tests, real Claude conversation QA, and review the diff/security behavior.

## Guardrails

- Invoke the operator-installed `claude` executable and its existing login; never persist or pass its OAuth credential into inference. Existing usage polling may read it transiently.
- Remove `ANTHROPIC_API_KEY` and API-provider environment variables from the child so the CLI cannot silently use API billing.
- Claude's built-in tools stay disabled. MCP calls are captured, not executed; Pi remains the only tool executor.
- Keep all workspace mutation, command permission, question, plan, and subagent behavior in the existing Pi/Jingler runtime.
- Do not add ACP or the Claude Agent SDK.
- Fail closed on malformed stream events, missing CLI authentication, unsupported images, or uncertain billing route.
