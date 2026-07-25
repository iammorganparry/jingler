# OpenConnector — unified MCP for every agent

> **Status: seed + documentation TODO.** This page captures the shape of the
> feature and tracks what still needs writing. See the checklist at the bottom —
> that is the "fully document this feature" task.

## What it is

One self-hosted [OpenConnector](https://github.com/oomol-lab/open-connector)
instance is the single MCP tool-store for **all** of Starbase's agents. A provider
connected once (in the in-app Connector Center) is available to every session on
every harness. Two halves:

1. **Unified `/mcp` injection** — Starbase points each launched agent at the
   instance's one `/mcp` endpoint, so `claude` / `codex` / `opencode` all load the
   same tools.
2. **Connector Center** — an in-app Settings surface to browse the instance's
   provider catalog and connect providers (OAuth / API-key / custom credential).

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

This replaced three sections (*MCP servers*, *Unified MCP*, *Connector Center*).
The read-only **MCP servers** view — which displayed each harness's OWN MCP
config — is **gone**, along with `McpService`, the `Mcp.list`/`Mcp.status` RPCs,
`McpStatusDialog`/`McpServerRow`, the composer's *MCP connectors* chip, and the
harness-config parsers in `mcp-config.ts`. Starbase no longer shows a harness's
non-OpenConnector MCP config: **OpenConnector is the single source of truth.**
`mcp-config.ts` keeps only the write-side injection helpers (`codexMcpOverrides`,
`opencodeMcpConfig`, `ParsedMcpServer`, `McpLaunch`, `normalizeEndpoint`).

## Architecture at a glance

| Concern | Where |
| --- | --- |
| Config (endpoint, enable, per-CLI) | `WorkspaceConfig.openConnector` — `packages/core/src/domain.ts` |
| Bearer token (never in config.json) | `SecretStore` → `~/starbase/open-connector.enc` |
| Injection resolver + live probe | `OpenConnectorService` — `packages/cli-adapters/src/open-connector.ts` |
| Connector-Center HTTP client | `OpenConnectorApi` — `packages/cli-adapters/src/open-connector-api.ts` |
| RPC contracts | `OpenConnector.*` + `Connector.*` — `packages/contracts/src/index.ts` |
| Settings UI | `ConnectorsSettings` (gate) → `OpenConnectorSection` + `ConnectorCenter` — `packages/ui/src/composites/` |
| Self-host | `infra/open-connector/` + repo-root `docker-compose.yml` |

## Per-harness injection (none touches the worktree)

`AgentRunner` resolves the server once (`OpenConnectorService.injection(cli)`) and
passes it on `SessionSpec.openConnector`; each adapter registers it in its own way:

- **Claude** — the SDK `query()` `mcpServers` option (`claude-adapter.ts`).
- **Codex** — `-c mcp_servers.<name>.url/http_headers.*` overrides on the app-server
  spawn (`codexMcpOverrides` → `startCodexAppServer.configOverrides`).
- **opencode** — a remote `mcp` block merged into `OPENCODE_CONFIG_CONTENT`
  (`opencodeMcpConfig`, `opencode-adapter.ts`).
- **Cursor** — Starbase has no cursor run path, so nothing to inject.

## Onboarding (auto-setup)

Settings › Unified MCP prefills an **environment-aware default** and offers a
one-click **Set up automatically** (`OpenConnector.autoSetup`):

- **Dev builds** (`!app.isPackaged`) → the local docker-compose instance
  (`http://localhost:3000`) with its shipped dev token (`local-dev-token`); auto-setup
  fills the endpoint + token and enables the feature.
- **Prod builds** (packaged) → the Starbase-**hosted** instance; auto-setup fills the
  endpoint but leaves it disabled until a token is provisioned.

Defaults are resolved in the main process (`openConnectorDefaults` in
`apps/desktop/src/main/rpc.ts`), overridable via `STARBASE_OPEN_CONNECTOR_URL` /
`OPEN_CONNECTOR_BASE_URL` / `OPEN_CONNECTOR_API_TOKEN`.

> **Gap:** `HOSTED_OPEN_CONNECTOR_URL` is a PLACEHOLDER (`https://connect.starbase.app`)
> and prod token provisioning is not built. The mechanism points prod at the hosted
> URL automatically the moment that URL + a token flow are real (see TODO below).

## Security model

- The bearer lives only in `SecretStore` (a sibling of `auth.enc`, survives sign-out).
- Provider credentials flow **inbound only** (renderer → main → OpenConnector, which
  owns the vault). No `OpenConnector.*` / `Connector.*` success payload carries a
  secret — enforced by tests.
- OAuth consent opens the system browser via `shell.openExternal`, guarded to
  `http(s)://` only; OpenConnector's own callback stores the grant.

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
