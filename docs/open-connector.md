# OpenConnector — unified MCP for every agent

> **Status: seed + documentation TODO.** This page captures the shape of the
> feature and tracks what still needs writing. See the checklist at the bottom —
> that is the "fully document this feature" task.

## What it is

One self-hosted [OpenConnector](https://github.com/oomol-lab/open-connector)
instance is the single **operator-configured** MCP tool-store for Jingler's
agents. A provider connected once (in the in-app Connector Center) is available
to every session on every harness. Two halves:

1. **Unified `/mcp` injection** — Jingler points each launched agent at the
   instance's one `/mcp` endpoint, so `claude` / `codex` / `opencode` all load the
   same tools.
2. **Connector Center** — an in-app Settings surface to browse the instance's
   provider catalog and connect providers (OAuth / API-key / custom credential).

This is separate from **`jingler-browser`**, Jingler's internal Preview browser
MCP server. OpenConnector exposes tools from services the operator connected;
`jingler-browser` exposes exactly seven tools for the native Preview dock:
`navigate`, `screenshot`, `click`, `type`, `read_text`, `evaluate`, and
`wait_for_selector`. It is created automatically for the desktop app's lifetime,
is not a Settings entry, and never controls an external or hidden browser.

## Settings › Connectors — one section, gated on a live connection

There is exactly **one** MCP entry in Settings: **Connectors**
(`ConnectorsSettings`, `packages/ui/src/composites/connectors-settings.tsx`). It
composes the connection setup (`OpenConnectorSection`) and the catalog
(`ConnectorCenter`) behind a **live probe**: opening the section runs
`OpenConnector.test`, and the catalog only appears once `state === "connected"`.
Until then the operator sees the setup view plus the failure reason — never an
empty "Search 0 providers" catalog that can't be told apart from a broken
instance. A **Manage connection** toggle reveals the setup again to change
instance.

Below the connection, **Agents receiving these tools** lists every harness with
the endpoint it will actually be launched with, resolved by
`OpenConnector.injection` → `OpenConnectorService.injectionTargets` — the same
`injection(cli)` the agent runner calls at spawn, so the readout cannot drift from
the launch. Four distinct "no" states are named rather than collapsed: `disabled`
(master switch/endpoint), `opted-out` (`perCli[cli] === false`, toggled per row),
`no-token`, and `no-run-path` (cursor — Jingler never launches it). The bearer
never crosses the RPC boundary; each row carries header *names* only.

This replaced three sections (*MCP servers*, *Unified MCP*, *Connector Center*).
The read-only **MCP servers** view — which displayed each harness's OWN MCP
config — is **gone**, along with `McpService`, the `Mcp.list`/`Mcp.status` RPCs,
`McpStatusDialog`/`McpServerRow`, the composer's *MCP connectors* chip, and the
harness-config parsers in `mcp-config.ts`. Jingler no longer shows a harness's
own MCP config: **OpenConnector is the single source of truth for
operator-configured connectors.** The internal `jingler-browser` attachment is
deliberately absent from Settings because it is an app capability rather than
operator configuration. `mcp-config.ts` keeps only the write-side injection
helpers (`codexMcpOverrides`, `opencodeMcpConfig`, `normalizeEndpoint`).

## Architecture at a glance

| Concern | Where |
| --- | --- |
| Config (endpoint, enable, per-CLI) | `WorkspaceConfig.openConnector` — `packages/core/src/domain.ts` |
| Bearer token (never in config.json) | `SecretStore` → `~/jingler/open-connector.enc` |
| Injection resolver + live probe | `OpenConnectorService` — `packages/cli-adapters/src/open-connector.ts` |
| Connector-Center HTTP client | `OpenConnectorApi` — `packages/cli-adapters/src/open-connector-api.ts` |
| Native Preview MCP | `BrowserControlMcpService` → `BrowserControlPort` → `PreviewViewService` |
| RPC contracts | `OpenConnector.*` + `Connector.*` — `packages/contracts/src/index.ts` |
| Settings UI | `ConnectorsSettings` (gate) → `OpenConnectorSection` + `ConnectorCenter` — `packages/ui/src/composites/` |
| Self-host | `infra/open-connector/` + repo-root `docker-compose.yml` |

## Per-harness injection (none touches the worktree)

`AgentRunner` resolves OpenConnector once (`OpenConnectorService.injection(cli)`)
and combines it with the app-scoped `jingler-browser` entry as
`SessionSpec.remoteMcpServers`. The operator-configured entry wins a duplicate
name deterministically. Each adapter registers the normalized collection in its
own way:

- **Claude** — the SDK `query()` `mcpServers` option (`claude-adapter.ts`).
- **Codex** — the URL and an `env_http_headers` reference are passed as `-c`
  overrides on the app-server spawn (`codexMcpOverrides` →
  `startCodexAppServer.configOverrides`); the bearer itself exists only in the
  child environment and is filtered from agent shell commands.
- **opencode** — a remote `mcp` block merged into `OPENCODE_CONFIG_CONTENT`
  (`opencodeMcpConfig`, `opencode-adapter.ts`).
- **Cursor** — Jingler has no cursor run path, so nothing to inject.

Neither attachment is written to a worktree or persisted on a session.
OpenConnector is independently optional: disabling it does not disable Preview
browser control, and failure to start the internal browser listener does not
remove a configured OpenConnector entry.

## Internal Preview browser MCP security

`jingler-browser` binds only to `127.0.0.1` on an ephemeral port for the desktop
app's managed lifetime. Every app start generates a random bearer token; the
listener rejects missing or incorrect authorization and invalid `Host` headers.
The URL and bearer travel only in the launched harness's in-memory MCP
configuration. They are not returned to the renderer, written to `config.json`,
or persisted with a session. Runtime disposal closes the listener. If binding
fails, ordinary sessions remain usable and only `jingler-browser` is omitted.

Every browser tool delegates through `BrowserControlPort` to
`PreviewViewService`, which owns the native Preview `WebContentsView`. A tool
operation reveals the dock and focuses its Browser tab so the operator sees the
same page the harness is inspecting.

## Onboarding (auto-setup)

Settings › Unified MCP prefills an **environment-aware default** and offers a
one-click **Set up automatically** (`OpenConnector.autoSetup`):

- **Dev builds** (`!app.isPackaged`) → the local docker-compose instance
  (`http://localhost:3000`) with its shipped dev token (`local-dev-token`); auto-setup
  fills the endpoint + token and enables the feature.
- **Prod builds** (packaged) → the Jingler-**hosted** instance; auto-setup fills the
  endpoint but leaves it disabled until a token is provisioned.

Defaults are resolved in the main process (`openConnectorDefaults` in
`apps/desktop/src/main/rpc.ts`), overridable via `JINGLER_OPEN_CONNECTOR_URL` /
`OPEN_CONNECTOR_BASE_URL` / `OPEN_CONNECTOR_API_TOKEN`.

> **Gap:** `HOSTED_OPEN_CONNECTOR_URL` is a PLACEHOLDER (`https://connect.jingler.app`)
> and prod token provisioning is not built. The mechanism points prod at the hosted
> URL automatically the moment that URL + a token flow are real (see TODO below).

## Security model

- The bearer lives only in `SecretStore` (a sibling of `auth.enc`, survives sign-out).
- Provider credentials flow **inbound only** (renderer → main → OpenConnector, which
  owns the vault). No `OpenConnector.*` / `Connector.*` success payload carries a
  secret — enforced by tests.
- OAuth consent opens the system browser via `shell.openExternal`, guarded to
  `http(s)://` only; OpenConnector's own callback stores the grant.

> **The instance itself does not authenticate.** Verified against
> `ghcr.io/oomol-lab/open-connector:latest`: `GET /v1/providers` and `POST /mcp`
> return **200 with a wrong bearer, or none at all** — `OPEN_CONNECTOR_API_TOKEN`
> gates nothing on those routes. Anything that can reach the port can drive every
> provider you have connected (your Slack, your GitHub). So compose publishes it as
> `127.0.0.1:3000:3000`, **not** `3000:3000`: on the original binding a laptop on a
> shared network was serving its credentials to that network. Any real deployment
> must put the instance behind its own authenticating proxy — Jingler sending a
> bearer is not a substitute, because the far end ignores it. `e2e/open-connector-live.spec.ts`
> documents this in place of the wrong-token test one would expect to find there.

## Documentation TODO — the task

- [ ] **Operator guide**: self-host (docker-compose), configure Settings › Unified
      MCP, connect a first provider, verify with Test.
- [ ] **Per-harness verification notes**, especially a live codex smoke test
      (confirm remote MCP over `-c` actually connects) and opencode.
- [ ] **Connector Center walkthrough** with screenshots (browse → connect OAuth,
      connect API-key, disconnect).
- [ ] **OpenConnector API surface** actually consumed (`/v1/providers`,
      `/api/connections`, `/api/oauth/*`) + the confirmed provider auth-field shape.
- [ ] **Threat model / secret handling** section, expanded from the summary above.
- [ ] **Troubleshooting**: "not configured", unreachable instance, timeout, OAuth
      redirect-URI mismatch.
- [ ] **Hosted instance**: stand up the real hosted OpenConnector, replace the
      `HOSTED_OPEN_CONNECTOR_URL` placeholder, and build prod token provisioning
      (likely via the auth backend) so prod auto-setup can enable end-to-end.
- [ ] **Follow-ups**: whether to gate the Unified MCP toggle per-harness; named
      connections in the Connector Center.
