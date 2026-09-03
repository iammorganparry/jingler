# Jingler-native MCP config (replace OpenConnector)

Replace the OpenConnector aggregator with an opencode-style declarative MCP
config owned by Jingler: one file the operator (or an importer) writes, one
resolver the runtime reads. Based on opencode's current MCP docs
(https://opencode.ai/docs/mcp-servers/).

## How opencode does it (research summary)

- One `mcp` object in `opencode.json`, keyed by unique server name.
- Two shapes: `{ type: "local", command: [...], environment: {...}, cwd?, enabled?, timeout? }`
  and `{ type: "remote", url, headers?, oauth?, enabled?, timeout? }`.
- Secrets go in the file as `{env:VAR_NAME}` placeholders, resolved at launch —
  the file itself stays committable/shareable.
- `enabled: false` disables without deleting; removal is deleting the key.
- Tools register with the server name as prefix; per-agent enablement is done
  through tool globs, not through the mcp block.
- OAuth for remote servers is automatic (DCR on 401), tokens stored separately
  in `mcp-auth.json` — never in the config file.

## What already exists in this repo (build on it, don't duplicate)

- `ImportedMcpService` (`packages/cli-adapters/src/runtime/resources/imported-mcp-service.ts`):
  a managed MCP catalog with metadata JSON + encrypted secret store, id
  reservation, enable/remove — plus `AgentResources.importMcp/remove/setEnabled/list/watch`
  RPCs already wired through `rpc.ts` and `rpc-client.ts`. **No Settings UI uses it yet.**
- The runtime already has an `imported` attachment slot
  (`JinglerMcpAttachments.imported` in `runtime/tools/mcp-tools.ts`) and
  `pi-runtime-live.ts` already calls `importedMcp.resolveForTarget(...)` — stdio
  and remote transports both bridge through the MCP SDK.
- `mcp-probe.ts`: full live-probe (initialize + tools/list, timeout, bounded
  concurrency) producing renderer-safe `McpServerStatus`.
- `packages/core/src/mcp.ts`: the redaction contract (`McpServer` carries
  `envKeys`/`headerKeys`, never values).

So this feature is mostly **wiring + UI + one importer + a large deletion**,
not a new subsystem.

## Architecture

### Config file: `~/jingler/mcp.json`

A dedicated file, NOT a key inside `config.json`. Reason: `WorkspaceConfig`
crosses the RPC boundary to the renderer and its documented invariant is
"carries no secret". An opencode-style file where operators paste
`Authorization: Bearer ...` headers must never ride that channel. `mcp.json`
is read only in the main process; the renderer gets the existing redacted
`McpServer` shape.

Format (deliberately opencode-compatible so entries copy across):

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" },
      "enabled": true
    },
    "linear": {
      "type": "local",
      "command": ["npx", "-y", "mcp-remote", "https://mcp.linear.app/sse"],
      "environment": { "FOO": "{env:FOO}" }
    }
  }
}
```

- `{env:VAR}` placeholders resolve from the main process environment at spawn;
  literal values are allowed (it's the operator's own file, same stance as
  opencode and `~/.claude.json`).
- Names validated against the existing `RESERVED_IDS` set (`browser`,
  `memory`, `jingler-*`, ...) so operator servers can't shadow internal ones.
- A malformed file never blocks a session: parse errors surface in Settings,
  runs proceed with the servers that parsed. Schema lives in `@jingler/core`
  next to `McpServer`.

### Resolution path (one path, replacing two)

New `McpConfigService` (main process): read + validate `mcp.json`, watch for
changes, expose:

- `list` → redacted `McpServer[]` for the renderer
- `resolve` → `RuntimeMcpServer[]` (env-interpolated) for the runtime
- `write(name, entry)` / `remove(name)` / `setEnabled(name, bool)` for the UI
  and importer — all mutations rewrite `mcp.json`, so hand-edit and UI-edit
  never diverge.

`AgentRunner` / `pi-runtime-live` feed the resolved list into the existing
`imported` slot of `JinglerMcpAttachments` (renamed `configured`). The
`openConnector` slot, `OpenConnectorService.injection()`, and the per-harness
injection helpers for it go away. Internal attachments (`jingler-browser`,
memory) are untouched and keep name-priority over configured servers via the
existing `composeRemoteMcpServers` dedupe.

`ImportedMcpService`'s catalog file + encrypted secret store are retired;
`AgentResources.importMcp/...` RPCs are re-pointed at `McpConfigService` (or
folded into new `Mcp.*` RPCs — whichever is the smaller diff at implementation
time). One catalog, one file.

### Status

Settings reuses `mcp-probe.ts` as-is: per-server connected/failed/toolCount,
user-initiated (probing spawns commands, so never automatic on file change).

Skipped for v1 (add when asked): project-scoped `.jingler/mcp.json`, OAuth/DCR
for remote servers (opencode-style auto-auth is a feature of its own — headers
cover today's cases), per-agent tool globs.

## Migration of MCPs

1. **OpenConnector users**: one-time migration on first read — if
   `config.json` has `openConnector.enabled: true`, write an equivalent entry
   into `mcp.json`:
   `"open-connector": { "type": "remote", "url": "<endpoint>/mcp", "headers": { "Authorization": "Bearer {secret}" } }`
   with the bearer copied out of `SecretStore` as a literal (it's leaving a
   Jingler-only store for an operator-editable file — the migration note in
   Settings says so). Then drop the `openConnector` key from `config.json`.
   Nothing breaks for users who never enabled it.
2. **Existing `ImportedMcpService` entries** (if any exist in the wild):
   same one-time rewrite into `mcp.json`, decrypting stored env/headers into
   the entry, then delete the old catalog + secret files.
3. **Importers** (the "import from claude / openai" ask) — a pure parser
   module + Settings button per source, each producing candidate entries the
   operator confirms before they're written:
   - **Claude**: `~/.claude.json` (`mcpServers`, incl. per-project) and
     repo `.mcp.json`.
   - **Codex/OpenAI**: `~/.codex/config.toml` (`mcp_servers`, TOML).
   - **opencode**: `~/.config/opencode/opencode.json` (`mcp`) — near-verbatim
     copy since our format matches.
   Import copies values as-is (including literal secrets those files already
   hold in plaintext); duplicate names get suffixed, reserved names rejected.

## Adding and managing MCPs

- **Hand-edit**: open `~/jingler/mcp.json` in any editor; Settings shows a
  "Reveal file" action. File watcher picks changes up live.
- **Settings › MCP servers** (replaces Connectors): redacted list of entries
  with scope-free name, transport, target summary, enable toggle, probe
  button + status, remove, add form (name, type, url/command, headers/env
  key-value rows), and the three import buttons. Values typed into the form
  are written to `mcp.json` verbatim — the redaction contract governs what
  comes *back* to the renderer, not what the operator sends in.
- **Enable/disable**: `enabled: false` in the entry, toggled from Settings —
  opencode semantics, keeps the entry for later.

## Removing MCPs

- Delete the key from `mcp.json` (by hand or the Settings remove action).
  No orphaned state: secrets live in the entry itself, so removing the entry
  removes everything.
- Migration cleanup deletes the retired stores: imported-MCP catalog file,
  its encrypted payloads, and the OpenConnector bearer in `SecretStore`.

## Deletions (the payoff)

- `OpenConnectorService`, `OpenConnectorApi` + tests
- `OpenConnector.*` / `Connector.*` RPC contracts and handlers
- `ConnectorsSettings`, `OpenConnectorSection`, Connector Center UI + tests
- `OpenConnectorConfig` from `domain.ts` (after migration release)
- `infra/open-connector/`, root `docker-compose.yml` service, e2e fake +
  live specs, `docs/open-connector.md` (replaced by a short `docs/mcp.md`)

## Open decisions (answer on review)

1. **Secrets in `mcp.json`**: plan says literal values allowed +
   `{env:VAR}` supported, file is main-process-only (opencode/Claude stance).
   Alternative is keeping the encrypted secret store and only references in
   the file — safer at rest, but kills hand-editability and the trivial
   importer. Confirm the plaintext-file stance.
2. **OpenConnector**: fully deleted, or kept one release behind the migration
   shim? Plan assumes full deletion in this change.

## Steps

- [x] Core: `McpConfigEntry` schema + `{env:VAR}` interpolation + name validation in `@jingler/core` (with tests)
- [x] `McpConfigService`: read/watch/resolve/write/remove/setEnabled over `~/jingler/mcp.json` (with tests)
- [x] Runtime wiring: resolved entries → `configured` attachments; delete `openConnector` slot and injection path
- [x] Importers: Claude JSON, Codex TOML, opencode JSON parsers (pure, tested on real-shape fixtures)
- [x] One-time migration: OpenConnector config + imported-MCP catalog → `mcp.json`
- [x] RPCs: `Mcp.list/status/write/remove/setEnabled/import` (reshape `AgentResources.*` MCP surface)
- [x] Settings UI: MCP servers section (list, probe, add, toggle, remove, import, reveal-file)
- [x] Deletions: OpenConnector service/API/UI/RPCs/infra/e2e/docs
- [x] Docs: `docs/mcp.md` (format, importers, security stance)
