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

Export the credential once in the shell profile used to launch your agent. This
keeps the token out of checked-in MCP configuration:

```sh
export JINGLER_MEMORY_URL="https://memory.example.com"
export JINGLER_MEMORY_TOKEN="jmem_xxxxxxxxxxxxxxxxxxxx"
export JINGLER_MEMORY_ORG="org_xxxxxxxxxxxxxxxx"
```

## Install this skill outside Jingler

Copy the **whole** `jingler-team-memory` directory, not only `SKILL.md`; the
references, hooks, and connection checker are part of the package.

For Codex, install it for every repository under the user skills directory:

```sh
mkdir -p "$HOME/.agents/skills/jingler-team-memory"
cp -R /ABSOLUTE/PATH/TO/jingler-team-memory/. \
  "$HOME/.agents/skills/jingler-team-memory/"
```

Use `.agents/skills/jingler-team-memory/` instead for a repository-scoped install.
Restart Codex after creating a skills directory, then confirm the skill appears in
`/skills`.

For Claude Code, install it for every repository under the personal skills
directory:

```sh
mkdir -p "$HOME/.claude/skills/jingler-team-memory"
cp -R /ABSOLUTE/PATH/TO/jingler-team-memory/. \
  "$HOME/.claude/skills/jingler-team-memory/"
```

Use `.claude/skills/jingler-team-memory/` for a repository-scoped install. Claude
Code detects changes inside an existing skills directory live; restart it if the
top-level directory did not exist when the session began.

## Claude Code

```bash
claude mcp add-json --scope user jingler-memory \
  '{"type":"http","url":"${JINGLER_MEMORY_URL}/api/mcp","headers":{"Authorization":"Bearer ${JINGLER_MEMORY_TOKEN}","x-jingler-organization-id":"${JINGLER_MEMORY_ORG}"}}'
```

The single quotes deliberately preserve `${...}` placeholders for Claude Code's
configuration-time environment expansion. Then `claude mcp list` should show
`jingler-memory` connected, and the `memory_*` tools become available.

## Codex

Add an MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.jingler-memory]
url = "https://memory.example.com/api/mcp"
bearer_token_env_var = "JINGLER_MEMORY_TOKEN"

[mcp_servers.jingler-memory.env_http_headers]
x-jingler-organization-id = "JINGLER_MEMORY_ORG"
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
`tools/list` enumerate the tools; `tools/call` invokes one. Native MCP
`initialize` responses also carry the complete recall/read/propose/poll operating
instructions, so clients that surface server instructions get the safe workflow
even before they load this skill.

## Verify

```bash
JINGLER_MEMORY_TOKEN="<TOKEN>" \
  scripts/check-connection.sh "<JINGLER_MEMORY_URL>" "<ORGANIZATION_ID>"
```

- Tools listed → connected.
- `401` → token missing/invalid, or the `x-jingler-organization-id` header is absent.
- `403` → the organization is not on a plan that enables team memory.

For an end-to-end agent check, ask it to do all four operations in one turn:

1. `memory_search` for a distinctive existing team fact.
2. `memory_read` the returned `pageId` and report the page/revision/source/citation ids.
3. `memory_propose` one harmless, durable setup note with `baseRevisionId: "new"`.
4. Poll the returned handle with `memory_workflow_status` until it settles, then
   search and read the published page (or report its typed terminal failure).

This tests retrieval and creation, rather than only tool discovery. Remove or
supersede the setup note afterward if it is not useful team knowledge.

## Security

The token is a credential scoped to your account and one exact organization. Never
commit it, paste it into code, or echo it into logs. Revoke it with the management
API immediately if it leaks.
