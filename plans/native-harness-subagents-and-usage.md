# Native harness subagents and cross-harness usage

- [ ] Retain a shared PI delegation host beyond native parent turns so detached children, workflows, transcripts, and fleet controls work identically in every harness.
- [x] Add no-PI-provider foreground child execution for native Claude, Codex, and OpenCode.
- [x] Expose one deterministic bounded foreground `subagent` contract to PI and every native harness.
- [x] Add provider-scoped role-to-model assignments in Settings and use the active provider's configured model for each task role.
- [x] Add default-on configurable delegation guidance that uses configured child assignments and skips trivial work.
- [x] Persist per-parent-turn and per-child-run usage facts with runtime/model attribution, nullable cost, token breakdown, duration, tools, outcome, and provenance.
- [x] Add an in-app cross-harness usage report and JSON export.
- [x] Add focused contract, lifecycle, credential, persistence, UI, native-child, cancellation, and Claude Electron E2E tests for the foreground slice.
- [ ] Add retained-host concurrency/restart/security tests and native-harness Electron E2E coverage for the remaining detached-work slice.
