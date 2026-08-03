# Jingler Team Memory — connection setup

The memory server is a remote **streamable-HTTP MCP** endpoint. Point any MCP-capable
harness at it with two headers.

## What you need

- **Base URL** (`<JINGLER_MEMORY_URL>`): your Jingler server. Local development
  defaults to `http://localhost:9100`; a hosted deployment is the URL your admin
  provides. The MCP path is always `<JINGLER_MEMORY_URL>/api/mcp`.
- **Access token** (`<TOKEN>`): an organization-scoped Jingler Memory personal
  access token, created with the API below. It starts with `jmem_` and is shown
  only once.
- **Organization id** (`<ORGANIZATION_ID>`): which team's memory to use. The token is
  bound to this exact organization and your live paid membership. Ask your admin,
  or read it from the desktop app's memory settings.

## Create a personal access token

Use your existing Jingler login bearer (the same session token held by the desktop)
to create a PAT. The requested role is optional and may only reduce, never exceed,
your current team role. Omit `expiresAt` for no expiry; an explicit future expiry is
safer for automation.

```bash
curl -fsS -X POST "<JINGLER_MEMORY_URL>/api/memory/tokens" \
  -H "Authorization: Bearer <JINGLER_SESSION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "<ORGANIZATION_ID>",
    "name": "Claude Code on my laptop",
    "role": "member",
    "expiresAt": "2027-08-03T00:00:00Z"
  }'
```

Copy the response's `token` immediately; the server stores only its SHA-256 hash
and cannot show the plaintext again. List safe metadata or revoke a token with:

```bash
curl -fsS "<JINGLER_MEMORY_URL>/api/memory/tokens?organizationId=<ORGANIZATION_ID>" \
  -H "Authorization: Bearer <JINGLER_SESSION_TOKEN>"

curl -fsS -X DELETE "<JINGLER_MEMORY_URL>/api/memory/tokens/<TOKEN_ID>" \
  -H "Authorization: Bearer <JINGLER_SESSION_TOKEN>"
```

Verification re-checks revocation, expiry, active paid plan, membership, and the
exact organization on every MCP request.

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
JINGLER_MEMORY_TOKEN="<TOKEN>" \
  scripts/check-connection.sh "<JINGLER_MEMORY_URL>" "<ORGANIZATION_ID>"
```

- Tools listed → connected.
- `401` → token missing/invalid, or the `x-jingler-organization-id` header is absent.
- `403` → the organization is not on a plan that enables team memory.

## Security

The token is a credential scoped to your account and one exact organization. Never
commit it, paste it into code, or echo it into logs. Revoke it with the management
API immediately if it leaks.
