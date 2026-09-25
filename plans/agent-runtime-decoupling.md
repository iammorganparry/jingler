# Agent runtime decoupling and native CLI roadmap

## Goal

Reposition Jingler as an agent-harness control surface. A user can run every supported agent already installed and authenticated on an execution target. PI remains available, but only as one runtime beside native Claude Code, Codex, and OpenCode.

Delivery order is fixed:

1. PI decoupling and direct Claude runtime
2. Native Codex runtime
3. Native OpenCode runtime

## Decisions

- Add an explicit runtime identity: `pi`, `claude`, `codex`, or `opencode`.
- The picker selects an **agent endpoint + model**, not a provider connection + model.
- Keep `ProviderConnection` inside the PI implementation. PI projects each provider connection into an agent endpoint.
- Native CLI adapters project detected installations or config profiles into agent endpoints.
- Endpoint IDs are globally unique and target-namespaced. The router resolves the endpoint and verifies its `targetId` matches the run target before resume, steer, or interrupt.
- Keep `providerId` on each model entry, not on the endpoint. One OpenCode endpoint can expose several providers.
- Persist runtime continuation as a tagged value. Never infer its owner from provider or model names.
- Route each turn through a small static runtime registry. Do not build a plugin framework.
- Keep normalized `StreamEvent`, Jingler transcripts, permissions, questions, explanations, MCP attachments, and target capability checks as app-owned contracts.
- Keep model capabilities separate from runtime capabilities. A runtime may honestly omit steer, plan review, background tasks, or subagents.
- Keep PI-backed Codex available beside native Codex. Label both clearly and never switch an existing session automatically.
- Discovery and auth checks run on the execution target. Desktop PATH is not evidence about a remote device.

## Target contracts

```ts
type AgentRuntimeId = "pi" | "claude" | "codex" | "opencode"
type AgentEndpointId = string

type AgentEndpoint = {
  id: AgentEndpointId
  runtimeId: AgentRuntimeId
  targetId: string
  label: string
  status: "ready" | "signed-out" | "missing" | "unsupported" | "error"
  version: string | null
  capabilities: AgentRuntimeFeatures
}

type AgentModelSelection = {
  runtimeId: AgentRuntimeId
  endpointId: AgentEndpointId
  providerId: ProviderId
  modelId: ProviderModelId
}

type RuntimeContinuation = {
  runtimeId: AgentRuntimeId
  endpointId: AgentEndpointId
  id: string
} | null
```

`AgentEndpointCatalog` contains endpoint records with their models. `AgentRunSpec` carries the selected identity and tagged continuation. The runtime router validates both `runtimeId` and `endpointId` before resume, steer, or interrupt, then the selected adapter resolves its own endpoint.

`AgentRuntimeFeatures` is a renderer-safe schema, separate from the existing target `RuntimeCapabilityManifest`:

```ts
type AgentRuntimeFeatures = {
  steer: "none" | "text" | "multimodal"
  planReview: boolean
  subagentFleet: boolean
  backgroundTasks: boolean
}
```

Features are endpoint-scoped and may be narrowed by a model entry later if a real provider requires it. Every operation still returns a typed unsupported result if availability changes after the UI rendered.

The base runtime contract remains deliberately small:

- `run`
- `interrupt`
- optional `steer`

Plan review, subagent fleet control, background-task handles, and runtime diagnostics are optional capability groups. Unsupported controls stay hidden or return a typed unsupported result; they never silently no-op.

---

# Stage 1 — Decouple PI and make Claude direct

**Estimate: 10–15 engineering days across six reviewable changes.**

## 1.1 Introduce runtime-neutral identity without changing behavior

- [x] Add `AgentRuntimeId`, `AgentEndpointId`, `AgentModelSelection`, and tagged `RuntimeContinuation` schemas in `packages/core/src/runtime`.
- [x] Rename `PiRunSpec` to `AgentRunSpec` in generic contracts.
- [x] Replace generic `piSessionId` names with `continuation`; retain compatibility decoding for persisted sessions and RPC payloads.
- [x] Thread runtime and endpoint identity through catalog selection, new-workspace defaults, composer selection, RPC contracts, `AgentRunner`, reviews, context management, and remote execution.
- [x] Initially migrate every existing session to `runtimeId: "pi"` so this change is behavior-preserving.
- [x] Clear a continuation whenever runtime or endpoint changes; seed the next runtime from Jingler's transcript.
- [x] Validate continuations against runtime and endpoint, then verify the resolved endpoint belongs to the run's execution target before resume, steer, or interrupt.

Primary files:

- `packages/core/src/runtime/agent-runtime.ts`
- `packages/core/src/runtime/provider-connection.ts`
- `packages/core/src/domain.ts`
- `packages/contracts/src/index.ts`
- `packages/cli-adapters/src/sessions.ts`
- `packages/cli-adapters/src/runtime/migration/legacy-runtime-identity.ts`
- `packages/cli-adapters/src/agent-runner.ts`
- `apps/desktop/src/renderer/conversation-machine.ts`

Acceptance:

- Existing sessions decode and continue through PI unchanged.
- Runtime switches, same-runtime endpoint switches, and identically named endpoints on different targets cannot reuse a foreign continuation ID.
- Session and chat identity updates are atomic.
- Migration tests cover old `piSessionId`, legacy CLI resume IDs, and partially migrated records.

## 1.2 Add the runtime registry and PI adapter

- [x] Change `AgentRuntimeShape` to consume `AgentRunSpec` and runtime-neutral continuation IDs.
- [x] Add a static `AgentRuntimeRegistry` keyed by `AgentRuntimeId` and a router used by `AgentTurnDriverLive`.
- [x] Register only PI first and wrap the current `PiAgentRuntimeLive` without changing its internals.
- [x] Require every router entry point to carry `{ runtimeId, endpointId }` or a validated tagged continuation; fresh roles cannot depend on continuation lookup.
- [x] Route interrupt, steer, plan review, fleet operations, title generation, publish metadata, reviews, and background roles through the owning runtime.
- [x] Keep `AgentRuntimeContext` as the common app-owned run envelope: permission/questions, MCP attachments, event journal, output bounds, file-change reconciliation, and cleanup. Each adapter owns only its vendor protocol loop.
- [x] Replace the singleton PI composition in desktop and device runtimes with the registry/router composition.
- [x] Rename generic `parentPiSessionId` fields to tagged runtime/endpoint ownership, or isolate them inside a PI-only fleet capability DTO.

Primary files:

- `packages/cli-adapters/src/runtime/agent/agent-runtime.ts`
- `packages/cli-adapters/src/runtime/agent/agent-turn-driver-live.ts`
- `packages/cli-adapters/src/runtime/agent/pi-agent-runtime.ts`
- `packages/cli-adapters/src/session-title-service.ts`
- `packages/cli-adapters/src/publish-metadata.ts`
- `packages/core/src/runtime/subagent-fleet.ts`
- `packages/contracts/src/index.ts`
- `apps/desktop/src/main/runtime.ts`
- `apps/desktop/src/main/rpc.ts`
- `apps/device-agent/src/device-executor.ts`
- `apps/device-agent/src/provider-runtime.ts`

Acceptance:

- All existing PI runtime tests pass through the router.
- Two simultaneous chats can select different registered runtimes.
- Unknown or unavailable runtimes fail before a turn starts with a typed error.

## 1.3 Replace the picker-facing provider catalog with endpoint catalog

- [x] Add `AgentEndpointCatalog`; keep the existing PI provider catalog behind a PI projection.
- [x] Retain `Provider.list` and provider auth RPCs for PI settings, certification, billing, and usage. Add separate `AgentEndpoint.list/refresh` and endpoint-auth RPC/events for native runtimes.
- [x] Give model entries their own status/selectability so one OpenCode endpoint can contain connected and disconnected providers.
- [x] Move picker grouping and defaults to endpoint identity while preserving provider/model labels.
- [x] Label routes clearly, for example `PI · OpenAI Codex` versus `Codex CLI`.
- [x] Keep PI certification and billing-route checks inside the PI endpoint projection.
- [x] Update settings and onboarding to show endpoint status separately from model-provider auth details.

Primary files:

- `packages/core/src/runtime/provider-catalog.ts`
- `packages/cli-adapters/src/runtime/providers/provider-catalog.ts`
- `packages/ui/src/composites/provider-model-browser.tsx`
- `packages/ui/src/composites/provider-connections-settings.tsx`
- `apps/desktop/src/renderer/use-provider-catalog.ts`
- `apps/desktop/src/renderer/app-machine.ts`

Acceptance:

- PI endpoints render and select exactly as before.
- Endpoint identity, not provider identity, determines runtime routing.
- OpenCode's future multi-provider shape can fit without changing these contracts again.

## 1.4 Make endpoint discovery target-local

- [x] Extend remote capability exchange to advertise target-scoped endpoint catalogs instead of only provider summaries.
- [x] Add bounded, versioned, correlated endpoint list/refresh/auth request-response messages plus catalog-update notifications on the device control channel.
- [x] Persist catalog updates server-side, reject stale or wrong-target responses, and republish the current catalog after reconnect.
- [x] Add runtime-specific protocol versions; make `piSdk` a PI adapter requirement rather than a universal target requirement.
- [x] Run CLI binary/version/auth probing on desktop or device agent according to the endpoint's `targetId`.
- [x] Propagate ready, signed-out, missing, unsupported, stale-agent, and refresh-failed states through server storage and desktop environment discovery.
- [x] Keep discovery read-only: invoke documented status/version commands and never parse vendor credential files.

Primary files:

- `packages/core/src/remote.ts`
- `packages/core/src/runtime/model-certification.ts`
- `apps/device-agent/src/capabilities.ts`
- `apps/device-agent/src/control-connection.ts`
- `apps/device-agent/src/provider-runtime.ts`
- `apps/device-relay/src/device-registry.ts`
- `apps/server/src/device-routes.ts`
- `apps/desktop/src/renderer/environment-machine.ts`

Acceptance:

- A remote target reports its own endpoints and models; desktop PATH never leaks into that result.
- Old device agents fail with a clear upgrade state rather than being treated as PI-capable native runtimes.
- Endpoint refresh and auth status survive relay reconnects; timeout, stale-response, and wrong-target cases are covered.

## 1.5 Extract Claude Code from PI

- [x] Move process/event handling from `claude-cli-provider.ts` into a direct `ClaudeAgentRuntime` with no PI model, sampling, or session types.
- [x] Let the Claude CLI own its native agent loop. Upgrade the run-scoped MCP bridge to execute Jingler tools and return results to the same live CLI process instead of stopping after the first tool call.
- [x] Parse and persist Claude's documented session ID, resume it explicitly, and fall back to transcript seeding only for fresh runs, runtime switches, or invalid continuations.
- [x] Preserve CLI-owned authentication by invoking `claude auth status`; never read or copy Claude credentials. Remove the current keychain/`~/.claude/.credentials.json` usage reader; show usage as unavailable until Claude exposes a supported command/API.
- [x] Add target-local binary/version/auth probing with distinct `missing`, `signed-out`, `unsupported`, and `error` states.
- [x] Give Claude its own model catalog. Use documented aliases and a small version-gated pinned list because Claude Code has no documented machine-readable model-list API.
- [x] Register Claude and PI concurrently in the runtime registry and endpoint catalog.
- [x] Preserve existing `claude-setup-token` sessions as compatibility PI endpoints. New onboarding creates native Claude endpoints; an explicit user switch clears the PI continuation and transcript-seeds the first native turn.
- [x] Migrate defaults and PI-only subagent assignments only when the user explicitly switches, and roll back the selection if the first native turn cannot start.
- [x] Retain the compatibility sentinel and packaged PI Claude extension while any persisted PI-Claude route depends on them; remove them in a later deprecation, not this migration.

Primary files:

- `packages/cli-adapters/src/runtime/providers/claude-cli-provider.ts`
- `packages/cli-adapters/src/runtime/providers/pi-provider-access.ts`
- `packages/cli-adapters/src/runtime/agent/pi-session-factory.ts`
- new `packages/cli-adapters/src/runtime/agent/claude-agent-runtime.ts`
- new `packages/cli-adapters/src/runtime/discovery/claude-cli.ts`
- `packages/cli-adapters/src/runtime/auth/auth-broker.ts`
- `packages/ui/src/composites/provider-auth-forms.tsx`

Acceptance:

- A new user with an authenticated Claude CLI sees a ready Claude endpoint without entering a token.
- Claude and PI appear together and can be selected independently.
- Claude supports several tool rounds in one live CLI turn, plus questions, steering, interruption, images, native resume, and restart recovery without constructing a PI `ModelRuntime`.
- Existing PI-backed Claude sessions keep their current behavior until the user explicitly switches.
- Switching one of several chats updates only that chat, preserves defaults unless selected, reconciles PI-only subagent assignments, and can roll back after a failed first native turn.

## 1.6 Enforce the new boundary

- [x] Invert `runtime-architecture.test.ts`: generic core, contracts, runner, onboarding, and UI must not import PI modules or contain PI-specific identity fields.
- [x] Stage the dependency guard: PI isolation in Stage 1, Codex adapter isolation in Stage 2, and `@opencode-ai/sdk` allowed only inside the OpenCode adapter in Stage 3.
- [x] Keep PI names only under PI implementation, provider, auth, and certification files.
- [x] Add endpoint migration, router dispatch, same-runtime/cross-endpoint continuation collision, runtime-switch, remote-target, and mixed-runtime tests.
- [x] Add one desktop E2E flow that detects Claude and PI, starts one session on each, switches explicitly, and reloads both.
- [x] Document the runtime/endpoint/provider vocabulary.

Stage 1 exit gate:

- PI is one registered runtime, not the app runtime.
- Native Claude executes with no PI runtime or model catalog dependency.
- New-user onboarding discovers supported CLIs on the selected target.
- The app can hold PI and Claude sessions concurrently across restart.

---

# Stage 2 — Native Codex

**Estimate: 5–8 engineering days after Stage 1.**

- [x] Add target-local Codex binary/version/auth probing. Use app-server `account/read` and native endpoint login RPCs; do not parse `auth.json` or reuse PI's `Provider.startCodexLogin`.
- [x] Implement a stdio `codex app-server` client with initialize/initialized negotiation, bounded JSONL framing, request timeouts, process cleanup, and version-matched generated schemas.
- [x] Build the Codex endpoint catalog from paginated `model/list` and capability responses.
- [x] Implement thread start/resume recovery (same-endpoint model switches resume; endpoint changes seed a new thread; native fork is not advertised), turn start, streaming event normalization, resident context usage, interruption, and steering where supported.
- [x] Correlate every JSON-RPC request, notification, and server request to its endpoint/process/thread so concurrent native Codex sessions cannot consume each other's events.
- [x] Map approval and user-input server requests into Jingler permissions and structured questions; inject run-scoped MCP attachments without exposing secrets.
- [x] Reuse the deleted adapter's protocol fixtures and event-mapping tests selectively. Do not restore its SDK fallback, duplicated plan loop, or old session orchestration wholesale.
- [x] Keep PI-backed Codex endpoints selectable and label native Codex separately. Existing sessions remain on their persisted runtime.
- [x] Replace the old architecture guard prohibition with a Codex adapter isolation rule.

Acceptance:

- An authenticated installed Codex CLI appears automatically with models from its own app-server.
- Native Codex supports prompt, resume, interrupt, permission decisions, tools/diffs, MCP, usage, and restart recovery.
- A user can run native Codex and PI-backed Codex side by side without sharing continuation IDs or billing identity.
- Fake app-server protocol tests are deterministic; a real-provider smoke test remains opt-in.

Stage 2 validation (workspace sandbox, September 25, 2026):

- 225 focused tests pass across 19 files, including native protocol/security,
  login lifecycle/control, PI routing, desktop RPCs and device execution.
- All eight affected package typechecks pass; desktop and device builds pass.
- Regenerated 111 unmodified protocol types from installed `codex-cli 0.153.2`.
- Native Electron specs now check tagged resume, a completed PI turn in a separate
  chat, settings cancellation and onboarding sign-in. Execution remains blocked
  by sandbox `listen EPERM` in the bundled-plugin `tsx` build. The relay Workers
  tests likewise cannot bind loopback in this sandbox.
- Repository lint reports five unchanged Stage 1 cognitive-complexity failures
  (reproduced from `25d5c12c`): `rpc.ts`, `agent-runner.ts`,
  `legacy-runtime-identity.ts`, `composer.tsx`, and `new-workspace-view.tsx`.
  Stage 2 adds no lint errors. No commit created; full gates remain for main.

Official integration contract:

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex models](https://developers.openai.com/codex/models)

---

# Stage 3 — Native OpenCode

**Estimate: 6–9 engineering days after Stage 2.**

- [x] Add target-local OpenCode discovery, minimum-version checks, and authenticated-provider probing without reading `auth.json`.
- [x] Start the user's own `opencode serve` on loopback with an ephemeral port and generated Basic-auth password; track the spawned process and reap its owned process tree without pattern-based kills.
- [x] Use the official generated SDK/HTTP API pinned to a tested server range; verify `/global/health` before enabling the endpoint.
- [x] Build models from OpenCode provider/config endpoints, preserving each model's provider ID under one OpenCode endpoint.
- [x] Implement session create/resume/fork, SSE event consumption, prompt, whole-turn abort, usage, tool/diff normalization, and restart recovery.
- [x] Correlate the global SSE stream by endpoint and session so concurrent OpenCode sessions cannot consume each other's events.
- [x] Map OpenCode permission requests into Jingler's permission gate. Advertise whole-turn abort honestly if per-task cancellation is unavailable.
- [x] Reuse historical OpenCode protocol fixtures and event tests only after validating them against the current server API.
- [x] Support multiple OpenCode config profiles as separate endpoints only when a real user configuration requires it; do not add speculative profile management.

The SDK and supported server are pinned to 1.18.14 and only the default user
profile is exposed. Deterministic fixtures use the pinned SDK's event and endpoint
shapes; full tests, affected typechecks, desktop/device builds, and P0/P1 review pass.

Acceptance:

- An authenticated installed OpenCode CLI appears automatically and lists all connected providers/models.
- Native OpenCode can run, resume, request permission, stream tools/output, abort, and recover after app restart.
- One OpenCode endpoint can expose multiple providers without special cases in the picker or session identity.
- Server startup, failed readiness, disconnect, and shutdown reap the owned process tree and leave no orphan process.

Official integration contract:

- [OpenCode server](https://opencode.ai/docs/server)
- [OpenCode SDK](https://opencode.ai/docs/sdk)
- [OpenCode providers](https://opencode.ai/docs/providers)
- [OpenCode permissions](https://opencode.ai/docs/permissions)

---

# Shared test and rollout gates

- [x] Contract tests: runtime/endpoint identity, tagged continuations, capability decoding, and backward migrations.
- [x] Adapter tests: vendor events to `StreamEvent`, process cleanup, abort races, malformed protocol data, and unsupported versions.
- [x] Product tests: onboarding detection, mixed-runtime picker, explicit switching, reload/resume, remote target discovery, and unavailable CLI recovery.
- [x] Security tests: no credential-file parsing, no credential events, environment sanitization, loopback-only servers, bounded output, and owned process-tree cleanup.
- [x] Release gates: fake-protocol CI for every runtime plus opt-in live certification against documented minimum and current CLI versions.

Deterministic native protocol suites remain in normal CI. Live certification is an
opt-in six-cell minimum/current matrix on protected credential-owning runners; the
release gate verifies complete, bounded, same-commit artifacts. Workspace tests,
affected typechecks, workflow parsing, product test discovery, and P0/P1 review pass.

## Explicit non-goals

- No general third-party runtime plugin system.
- No bundled Codex or OpenCode binary.
- No automatic migration from PI-backed Codex to native Codex.
- No promise that every runtime supports PI subagents, plan review, background tasks, or identical steering.
- No Cursor/Grok support in these three stages.
- No wholesale resurrection of the pre-PI adapters available at `430da133^`; `430da133` is the deletion commit.

## Research references

- [T3 Code README](https://github.com/pingdotgg/t3code/blob/main/README.md) — agent-harness control-surface positioning and installed-CLI onboarding.
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [OpenCode server](https://opencode.ai/docs/server)
