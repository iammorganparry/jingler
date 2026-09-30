# Native harness subagents and cross-harness usage

## Completed foreground slice

- [x] Add no-PI-provider foreground child execution for native Claude, Codex, and OpenCode.
- [x] Expose one deterministic bounded foreground `subagent` contract to PI and every native harness.
- [x] Add provider-scoped role-to-model assignments in Settings and use the active provider's configured model for each task role.
- [x] Add default-on configurable delegation guidance that uses configured child assignments and skips trivial work.
- [x] Persist per-parent-turn and per-child-run usage facts with runtime/model attribution, nullable cost, token breakdown, duration, tools, outcome, and provenance.
- [x] Add an in-app cross-harness usage report and JSON export.
- [x] Add focused contract, lifecycle, credential, persistence, UI, native-child, cancellation, and Claude Electron E2E tests for the foreground slice.

## Retained background and workflow slice

- [x] Extract the existing retained PI session registry into a reusable session/chat-owned host that keeps delegation-only PI handles alive while detached work is active, rebinds each live turn context, archives transcripts, and disposes exactly once after the final child settles.
- [x] Extend the native `subagent` tool with bounded async single, parallel, and chain requests while preserving the current foreground single-child path; translate the structured request into pi-subagents' public async RPC instead of adding a second workflow engine.
- [x] Register Jingler-owned native external-job profiles/provider bindings for Codex and OpenCode async leaves, keyed by parent PI session and role/model assignment, while Claude continues through its bundled PI provider route. Persist provider-job identity, terminal output, usage provenance, and transcript material needed for reattachment without redispatch.
- [x] Route native Claude, Codex, and OpenCode fleet snapshots, transcripts, and controls through the retained host after the parent turn ends. Support stop and follow-up everywhere; use live steer/reply only where the underlying runtime supports it, returning explicit unsupported outcomes elsewhere.
- [x] Recover retained hosts and terminal transcripts from durable lifecycle artifacts after reload/restart. Proven-active PI children remain attached; native jobs that cannot be proven live fail closed and are never silently restarted or double-counted.
- [x] Add concurrency, ownership, restart, credential cleanup, capability-ceiling, cancellation, and idempotent usage tests covering same-chat serialization, cross-chat isolation, cross-session denial, final-child disposal, and stale-job pruning.
- [x] Add parameterized Electron E2E coverage for Claude, Codex, and OpenCode detached workflows: parent turn settles, Fleet remains visible, a second parent turn works, transcript opens, stop works, and one cold-restart case restores durable terminal state.
- [x] Run package typechecks, focused runtime/security tests, the full test/lint gates, native-harness Electron E2E, and update `docs/subagent-fleet.md` plus the changeset with retained-host behavior and honest control capability notes.

### Acceptance

- A detached workflow launched from any native harness outlives the parent turn and remains visible through the same Fleet contract.
- Provider-scoped role/model selection still applies, including installations with no configured PI provider.
- Snapshot, transcript, stop, follow-up, ownership checks, and terminal usage are deterministic across harnesses; unsupported live controls fail explicitly rather than pretending success.
- Restart recovery never redispatches an ambiguous job, leaks credentials/capability tokens, or attributes one child completion twice.
- All focused and repository gates pass, including the three native-harness Electron cases.
