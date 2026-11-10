# claude.ai connectors native + MCP banner collapse

## 1. Native claude.ai connectors in Claude sessions <!-- id: native-connectors -->
- [ ] Cache `claude mcp list` connector rows (name, url, status) in main; refresh on Settings open / probe
- [ ] `claudeAgentArguments` / `claudeCliArguments`: when connectors remain after dedupe, drop `--strict-mcp-config`, use `--setting-sources user`, pass `--settings` overlay (`disableAllHooks`, user plugins off, `allowedMcpServers` = relay URL + connector URLs)
- [ ] Dedupe: skip connector URLs already present in mcp.json (and skills already provided by Jingler)
- [ ] Unit tests for argument building + dedupe

## 2. Settings: read-only claude.ai group <!-- id: settings-group -->
- [ ] Show connectors with auth state from `claude mcp list`
- [ ] Connect opens claude.ai connector settings in the browser
- [ ] Stop importing `claude.ai *` rows as plain-URL OAuth entries

## 3. 401 on a remote with no auth block <!-- id: noauth-401 -->
- [ ] Probe 401 on `authKind: "none"` remote → needs-auth
- [ ] Managed OAuth allowed for those entries (writes `auth: {type: "oauth"}` on Connect)

## 4. Banner collapse <!-- id: banner -->
- [ ] `RuntimeRecoveryCard` gets optional `moreLabel` / `onMore` (story + test, COMPONENTS.md row)
- [ ] `McpRecoveryCards` renders first card + "+N more" → Settings › MCP servers (`connectors`)
- [ ] `openSettings("connectors")` plumbed as `onOpenMcpSettings`

## 5. Verification <!-- id: verify -->
- [ ] e2e: extend `mcp-import-claudeai.spec.ts`
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `e2e:affected`
