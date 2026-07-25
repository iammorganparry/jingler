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

## Architecture at a glance

| Concern | Where |
| --- | --- |
| Config (endpoint, enable, per-CLI) | `WorkspaceConfig.openConnector` — `packages/core/src/domain.ts` |
| Bearer token (never in config.json) | `SecretStore` → `~/starbase/open-connector.enc` |
| Injection resolver + live probe | `OpenConnectorService` — `packages/cli-adapters/src/open-connector.ts` |
| Connector-Center HTTP client | `OpenConnectorApi` — `packages/cli-adapters/src/open-connector-api.ts` |
| RPC contracts | `OpenConnector.*` + `Connector.*` — `packages/contracts/src/index.ts` |
| Settings UI | `OpenConnectorSection` + `ConnectorCenter` — `packages/ui/src/composites/` |
| Self-host | `infra/open-connector/` + repo-root `docker-compose.yml` |

## Per-harness injection (none touches the worktree)

`AgentRunner` resolves the server once (`OpenConnectorService.injection(cli)`) and
passes it on `SessionSpec.openConnector`; each adapter registers it in its own way:

- **Claude** — the SDK `query()` `mcpServers` option (`claude-adapter.ts`).
- **Codex** — `-c mcp_servers.<name>.url/http_headers.*` overrides on the app-server
  spawn (`codexMcpOverrides` → `startCodexAppServer.configOverrides`).
- **opencode** — a remote `mcp` block merged into `OPENCODE_CONFIG_CONTENT`
  (`opencodeMcpConfig`, `opencode-adapter.ts`).
- **Cursor** — read-only in Settings; Starbase has no cursor run path, so nothing
  to inject.

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
- [ ] **Follow-ups**: whether to gate the Unified MCP toggle per-harness; named
      connections in the Connector Center.
