# Native Codex adapter

This adapter speaks stdio app-server JSONL directly. It has no PI model/session
imports and no Codex SDK fallback. Desktop and device runtimes register it next to
PI and Claude; existing PI identities are unchanged.

Protocol source: installed `codex-cli 0.153.2`, generated September 25, 2026.
Regenerate the unmodified TypeScript dependency closure with:

```sh
node scripts/generate-codex-protocol.mjs
```

The checked-in protocol types come from 0.153.2, but discovery talks to the
installed CLI so compatible updates expose their current model catalog without a
Jingler release. Protocol incompatibilities fail the probe instead of hiding every
newer version up front. Generation uses the stable schema command; initialize
opts into experimental messages for structured user input. Wire envelopes, frame
sizes, queue sizes, pending requests, model pagination and output previews are
bounded. Generated types constrain the payloads; they are not runtime validators
for every vendor response field. Malformed used fields fail the run.

Each run owns a process. Request IDs are process-local; notifications and server
requests must match the active thread, and turn IDs are checked before control or
permission responses. Resume reopens the tagged thread ID, including a model
change within the same endpoint. Endpoint changes clear the continuation and
seed a new thread from the transcript. Native fork is not advertised. Missing
persisted threads alone fall
back to a fresh transcript seed. Other RPC failures never silently start over.
The adapter closes its owned process group on cleanup, timeout, malformed frames,
and app shutdown on POSIX. Native Windows is unsupported: probing, login and runs
fail closed before launching any process until owned Job Object cleanup exists.

Plan uses the same workspace-write sandbox and on-request approval policy as auto.
Read-only uses the read-only sandbox with never approval policy and denies any
incoming command, edit or permission approval request. Ask is rejected before
launch: the generated AskForApproval union has no policy guaranteeing every edit
and command is approved through Jingler. In particular, untrusted can allow
workspace edits without a request (see the official approvals/security guide).

Authentication uses account/read. Native device-code login uses
account/login/start and account/login/cancel with completion correlation and a
ten-minute process lifetime. No credential files are read. Desktop exposes
AgentEndpoint.startLogin/cancelLogin RPCs; account state is refreshed through the
endpoint catalog. Remote catalog/auth-status probing runs on the device.
Target-scoped login-start/cancel travel through the authenticated device control
contract. Settings and onboarding share a native device-code login component with
explicit status refresh. Device codes are transient replies, never discovery
storage.

MCP attachments use run-local thread config and child environment references for
credentials. Inherited environment reuses nativeCliEnvironment, extended only with CODEX_HOME,
CODEX_CA_CERTIFICATE and SSL_CERT_FILE; only explicit
run-scoped MCP values are added back. STDIO and static-header Streamable HTTP attachments are supported;
SSE and host-owned OAuth callbacks fail explicitly. Native MCP elicitation,
secret user-input fields, dynamic client tools, attestation and external-token
refresh requests are rejected. No PI fleet, plan-review or background-task
capability is advertised. Native tool diffs are normalized; the PI-only final
filesystem reconciliation hook is not reused by this adapter.

model/list supplies models, reasoning and input modalities for both the native
endpoint and PI's Codex subscription route. PI fills fields app-server does not
report (context, output limit, pricing and compatibility) from the closest
same-family model already shipped by pi-ai. It does not invent an authoritative
web-search capability.
Live usage uses last.totalTokens for resident context and modelContextWindow for
the gauge. Done counts the run's token delta rather than historical thread totals.
App-server does not report dollar cost; the existing numeric event contract uses
zero, which must not be interpreted as verified free usage.

Deterministic fake-server coverage lives in runtime.test.ts. Resident-context and
cumulative-command-output cases were adapted selectively from
430da133^:packages/cli-adapters/src/codex-app-server-events.test.ts. No historical
orchestration, plan loop or SDK fallback was restored. The Electron spec lives at
apps/desktop/e2e/native-codex.spec.ts; live provider certification remains opt-in.

References checked for this implementation:
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/mcp
