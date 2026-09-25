# Native OpenCode

The official SDK is pinned to `1.18.14`. The supported server interval is the
singleton `[1.18.14, 1.18.14]`; both CLI version and authenticated `/global/health`
must match before use. Widening this range requires real-server certification.
No certification against a live provider is claimed by the protocol fixtures.

Each execution target discovers its own binary and starts its own default user
configuration. One endpoint exposes connected providers with `(providerId,
modelId)` identity. There is no profile manager, attached-server URL, or parsing
of `auth.json`. Sign in with `opencode auth login` on the target and refresh the
catalog. Provider/model discovery uses `/provider` and `/config/providers`.

Servers bind only to `127.0.0.1` on an ephemeral port, with a new 256-bit Basic-auth
password. Credentials stay in the child environment and HTTP headers; redirects
and foreign origins are rejected. The environment allowlist strips inherited
provider keys, Node injection, and OpenCode config overrides. The configured
user HOME/XDG directories remain available to the user's CLI. POSIX process
groups are owned and reaped through the shared child registry, including failed
startup, shutdown, and stream disconnect. Windows fails closed because the
repository does not yet supply Windows Job Object ownership.

Turns subscribe before prompting. Directory, session, and assistant parent
message correlate events; raw response bytes, queued events, text, catalog size,
and tool previews are bounded. Sync and legacy message envelopes are supported.
Session IDs persist through the generic tagged continuation/journal contract.
Only a missing (404) native session seeds a new one; authorization, directory,
and other lookup failures fail closed. Session forking is an adapter helper;
the generic runtime contract currently has no fork operation.

All writes ask the Jingler permission gate, with one-time permission replies.
Read-only roles deny writes. Task/question permissions are denied, and unexpected
question requests are rejected. Stop aborts the entire native turn. Per-task
cancellation, steering, plan review, subagents, background tasks, and run-scoped
MCP attachments are unsupported; native OpenCode does not acquire Jingler's
browser MCP lease. Its own user-configured tools remain native to OpenCode.

Validation:

- `runtime.test.ts` exercises the real SDK HTTP/SSE parser using an injected
  socket-free transport and real owned fixture processes. It covers discovery,
  auth generation, startup errors, concurrent turns, resume, fork, permissions,
  abort, disconnect, bounds, and cleanup.
- `events.test.ts` covers old-turn isolation, delta/snapshot deduplication, tools,
  diffs, sync envelopes, and malformed usage/text.
- `fixtures/server.mjs` is the executable authenticated HTTP/SSE fixture for
  `apps/desktop/e2e/native-opencode.spec.ts` (picker, persistence, onboarding).
- Real HTTP and Electron validation remain required: this workspace sandbox
  rejects loopback/Unix socket listeners (`EPERM`), including the plugin build's
  tsx IPC listener. The repository-wide typecheck also hits a device-agent
  native `.node` bundling failure. Do not mark Stage 3 complete on the strength
  of the injected-transport tests alone.
