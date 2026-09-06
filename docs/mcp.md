# MCP servers — `~/jingler/mcp.json`

Jingler's agents get their operator-configured MCP tools from one file:
`~/jingler/mcp.json`. Edit it by hand or manage it from **Settings › MCP
servers** — both write the same file, so they can never diverge. Every enabled
entry is attached to local sessions on the next turn; no restart needed.

The format is deliberately [opencode](https://opencode.ai/docs/mcp-servers/)-
compatible, so supported entries copy between the two configs without reshaping.

## Format

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" },
      "enabled": true
    },
    "docs": {
      "type": "local",
      "command": ["npx", "-y", "docs-mcp"],
      "environment": { "DOCS_KEY": "{env:DOCS_KEY}" },
      "cwd": "/optional/working/dir"
    }
  }
}
```

- **`type: "remote"`** — `url` (streamable HTTP; add `"transport": "sse"` for
  legacy SSE servers) plus optional `headers`.
- **`type: "local"`** — `command` as argv (never shell-interpreted), optional
  `environment` and `cwd`. Without `cwd`, the server runs from the session's
  worktree.
- **`enabled: false`** disables an entry without deleting it. Removal is
  deleting the key. A positive `timeout` is preserved for opencode compatibility.
- OpenCode's remote `oauth` setting is not supported yet; use explicit headers.
- **`{env:VAR}`** placeholders in header/environment values resolve from the
  main process environment at launch, so the file itself can stay secret-free.
  Literal values also work — it is the operator's own file, same stance as
  opencode's config and `~/.claude.json`.

Names are 1–64 characters of letters, digits, `.`, `_`, `-`. A few names are
reserved for Jingler's internal attachments (`browser`, `memory`,
`jingler-*`, …) — see `MCP_RESERVED_NAMES` in `packages/core/src/mcp-config.ts`.

A malformed file never blocks a session: runs proceed without the configured
servers and Settings shows the parse error.

## Importing from other tools

Settings › MCP servers can import existing definitions from:

- **Claude** — `~/.claude.json` (`mcpServers`, including per-project blocks)
- **Codex** — `~/.codex/config.toml` (`[mcp_servers.*]`; a
  `bearer_token_env_var` becomes an `Authorization: Bearer {env:VAR}` header)
- **opencode** — `~/.config/opencode/opencode.json` (copied verbatim)

Candidates are shown for confirmation (names + targets only; secret values are
re-read in the main process when you apply). Existing names are skipped.

## Security model

- `mcp.json` may hold literal secrets, so it is read **only in the main
  process**. The renderer receives the redacted `McpServer` shape (header/env
  *names*, never values) — the same redaction contract enforced by
  `packages/core/src/mcp.ts`.
- Values typed into the Settings add form travel inbound once and land in the
  file; nothing echoes them back.
- The internal `jingler-browser` (Preview control) is an app capability, not an
  entry in this file, and always wins a name clash.

## Where things live

| Concern | Where |
| --- | --- |
| File schema + `{env:VAR}` interpolation | `McpConfigFile` — `packages/core/src/mcp-config.ts` |
| Read/write/resolve service | `McpConfigService` — `packages/cli-adapters/src/mcp-config-service.ts` |
| Runtime attachment (per run) | `configured` slot — `runtime/agent/pi-runtime-live.ts` |
| Importers (pure parsers) | `packages/cli-adapters/src/mcp-import.ts` |
| Live probe (`initialize` + `tools/list`) | `packages/cli-adapters/src/mcp-probe.ts` |
| RPCs | `Mcp.*` — `packages/contracts/src/index.ts` |
| Settings UI | `McpSettings` — `packages/ui/src/composites/mcp-settings.tsx` |

## Migration from OpenConnector

OpenConnector (the previous unified-MCP aggregator) is gone. On first start
without an `mcp.json`, Jingler migrates automatically
(`packages/cli-adapters/src/mcp-migration.ts`):

- an enabled OpenConnector config becomes a remote entry (its SecretStore
  bearer is written into the entry as a literal header), and the stored bearer
  is cleared;
- previously imported managed MCP servers become plain entries, their
  encrypted values decrypted into the file, and the old catalog is deleted.

The migration never touches an existing `mcp.json`; with nothing to migrate it leaves no file behind.
