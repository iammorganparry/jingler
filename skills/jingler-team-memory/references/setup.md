# Jingler Team Memory — connection setup

The memory server is a remote **streamable-HTTP MCP** endpoint. Point any MCP-capable
harness at it with two headers.

## What you need

- **Base URL** (`<JINGLER_MEMORY_URL>`): your Jingler server. Local development
  defaults to `http://localhost:9100`; a hosted deployment is the URL your admin
  provides. The MCP path is always `<JINGLER_MEMORY_URL>/api/mcp`.
- **Access token** (`<TOKEN>`): a personal access token for your Jingler account.
  <!-- TODO(pat): replace with the real issuance step once PAT generation ships,
       e.g. "Create one under Settings › Access tokens in the Jingler dashboard, or
       run `jingler token create`." Until then, obtain a token from your Jingler
       admin / the desktop app. -->
- **Organization id** (`<ORGANIZATION_ID>`): which team's memory to use. The token is
  bound to your account; the org id selects the vault. Ask your admin, or read it from
  the desktop app's memory settings.

The endpoint requires **both** headers on every request:

```
Authorization: Bearer <TOKEN>
x-jingler-organization-id: <ORGANIZATION_ID>
```

## Claude Code

```bash
claude mcp add --transport http jingler-memory \
  "<JINGLER_MEMORY_URL>/api/mcp" \
  --header "Authorization: Bearer <TOKEN>" \
  --header "x-jingler-organization-id: <ORGANIZATION_ID>"
```

Then `claude mcp list` should show `jingler-memory` connected, and the `memory_*`
tools become available.

## Codex

Add an MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.jingler-memory]
url = "<JINGLER_MEMORY_URL>/api/mcp"

[mcp_servers.jingler-memory.headers]
Authorization = "Bearer <TOKEN>"
x-jingler-organization-id = "<ORGANIZATION_ID>"
```

(HTTP MCP support requires a recent Codex CLI; check `codex --version` and the Codex
MCP docs if the server doesn't appear.)

## Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "jingler-memory": {
      "url": "<JINGLER_MEMORY_URL>/api/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>",
        "x-jingler-organization-id": "<ORGANIZATION_ID>"
      }
    }
  }
}
```

## Generic MCP client

Any client that speaks MCP over streamable HTTP works: `POST` JSON-RPC 2.0 to
`<JINGLER_MEMORY_URL>/api/mcp` with the two headers above. `server/discover` and
`tools/list` enumerate the tools; `tools/call` invokes one.

## Verify

```bash
scripts/check-connection.sh "<JINGLER_MEMORY_URL>" "<TOKEN>" "<ORGANIZATION_ID>"
```

- Tools listed → connected.
- `401` → token missing/invalid, or the `x-jingler-organization-id` header is absent.
- `403` → the organization is not on a plan that enables team memory.

## Security

The token is a credential scoped to your account and the chosen org. Never commit it,
paste it into code, or echo it into logs. Rotate/revoke it from the Jingler dashboard
if it leaks.
