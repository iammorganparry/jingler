# Self-hosted OpenConnector — the unified MCP store

One central [OpenConnector](https://github.com/oomol-lab/open-connector) instance
that every Starbase agent (`claude` / `codex` / `cursor` / `opencode`) draws its MCP
tools from. Connect a provider (GitHub, Slack, Notion, …) **once** in its web
console and it's available to all agents, in every session — no per-harness MCP
config to keep in sync.

Starbase points each agent at this instance's single `/mcp` endpoint at launch (see
`packages/cli-adapters/src/open-connector.ts`). The credential for that endpoint is
stored in the OS keychain via `SecretStore`, never in `config.json`.

## Run it

Local dev — it's in the repo-root `docker-compose.yml`, so from the repo root:

```bash
docker compose up -d open-connector   # or `docker compose up -d` for the whole stack
open http://localhost:3000            # web console — connect providers here
```

That uses zero-setup dev defaults (API token `local-dev-token`). Standalone /
production self-hosting uses this directory's compose + real secrets:

```bash
cp .env.example .env          # fill in the two generated secrets
docker compose up -d
```

- **Web console / API docs:** http://localhost:3000 (`/docs` for the OpenAPI ref)
- **MCP endpoint (what Starbase uses):** http://localhost:3000/mcp
- **Auth:** every `/mcp` call must send `Authorization: Bearer $OPEN_CONNECTOR_API_TOKEN`

## Wire Starbase to it

In the desktop app → **Settings → Unified MCP**:

1. **Endpoint:** `http://localhost:3000` (no `/mcp` suffix — the app appends it)
2. **Token:** the `OPEN_CONNECTOR_API_TOKEN` — `local-dev-token` with the root compose defaults, or the value from your `.env`
3. **Enable**, then hit **Test** to confirm the handshake and tool count.

Once enabled, the server is injected into each agent as it launches:

- **Claude** — inline via the SDK `mcpServers` option (bypasses `.mcp.json` approval).
- **Codex / Cursor / opencode** — *not yet wired* (see the branch thread / plan step 06);
  these need their config-format injection verified before shipping.

## Deploying beyond local

OpenConnector also targets Fly.io (SQLite volume) and Cloudflare Workers (D1 + R2).
Pin the image to a digest for anything shared, and put it behind TLS so the bearer
token isn't sent in the clear. See the upstream repo's deployment docs.
