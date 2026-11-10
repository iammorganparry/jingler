import type { ClaudeConnector, McpImportCandidateView, McpImportSourceId, McpRegistryEntry, McpServer, McpServerStatus } from "@jingler/core"
import * as React from "react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { McpConnectorsView, type McpCatalogEntry, type McpCatalogOrigin, type McpConnectorRow, type McpRowState } from "./mcp-connectors.js"
import { McpAddServerDialog, McpServerDrawer } from "./mcp-server-drawer.js"
import { McpApiKeyDialog, type McpSettingsProps } from "./mcp-settings.js"

const CLAUDE_AI = "claude.ai "
const sameUrl = (url: string) => url.replace(/\/+$/, "")

const serverState = (server: McpServer, status: McpServerStatus | undefined): McpRowState => {
  if (server.authState === "needs-auth" || status?.state === "needs-auth") return "needs-auth"
  if (status?.state === "failed") return "failed"
  if (status?.state === "connected") return "connected"
  return "pending"
}

/** mcp.json servers plus the claude.ai connectors the Claude CLI runs natively (duplicates dropped). */
export const mcpRows = (
  servers: ReadonlyArray<McpServer>,
  statuses: ReadonlyArray<McpServerStatus> | null,
  connectors: ReadonlyArray<ClaudeConnector>
): ReadonlyArray<McpConnectorRow> => [
  ...servers.map((server): McpConnectorRow => {
    const status = statuses?.find((candidate) => candidate.name === server.name)
    return {
      id: server.name,
      displayName: server.displayName,
      iconUrl: server.iconUrl,
      target: server.target,
      source: server.name.startsWith("plugin-") ? "plugin" : "jingler",
      agents: "All agents",
      state: serverState(server, status),
      toolCount: status?.state === "connected" ? status.toolCount : null,
      enabled: server.enabled
    }
  }),
  ...connectors.filter((connector) => !connector.duplicate).map((connector): McpConnectorRow => ({
    id: `claude.ai:${connector.name}`,
    displayName: connector.name.replace(CLAUDE_AI, ""),
    iconUrl: null,
    target: connector.url,
    source: "claude.ai",
    agents: "Claude",
    state: connector.state === "needs-auth" ? "needs-auth" : connector.state === "failed" ? "failed" : connector.state === "connected" ? "connected" : "pending",
    toolCount: null,
    enabled: true
  }))
]

type CatalogAction =
  | { readonly kind: "import"; readonly source: McpImportSourceId; readonly name: string }
  | { readonly kind: "registry"; readonly entry: McpRegistryEntry }

const HARNESS_ORIGIN: Record<McpImportSourceId, McpCatalogOrigin> = { claude: "claude-code", codex: "codex", opencode: "opencode" }
const HARNESSES: ReadonlyArray<McpImportSourceId> = ["claude", "codex", "opencode"]

/** Discover: claude.ai connectors, other harnesses' servers, then the registry. Each entry knows how it's added. */
export const mcpCatalog = (
  servers: ReadonlyArray<McpServer>,
  rows: ReadonlyArray<McpConnectorRow>,
  connectors: ReadonlyArray<ClaudeConnector>,
  candidates: ReadonlyArray<McpImportCandidateView>,
  registry: ReadonlyArray<McpRegistryEntry>
): { readonly entries: ReadonlyArray<McpCatalogEntry>; readonly actions: ReadonlyMap<string, CatalogAction> } => {
  const actions = new Map<string, CatalogAction>()
  const rowFor = (match: (server: McpServer) => boolean) => {
    const server = servers.find(match)
    return server === undefined ? undefined : rows.find((row) => row.id === server.name)
  }
  const entries = [
    ...connectors.map(connectorEntry),
    ...candidates.flatMap((candidate) => candidateEntry(candidate, rowFor((server) => server.name === candidate.name), actions)),
    ...registry.flatMap((entry) => registryEntry(entry, rowFor, actions))
  ]
  return { entries, actions }
}

const connectorEntry = (connector: ClaudeConnector): McpCatalogEntry => ({
  id: `ca:${connector.name}`,
  origin: "claude.ai",
  displayName: connector.name.replace(CLAUDE_AI, ""),
  iconUrl: null,
  description: connector.duplicate ? "Also in mcp.json — Jingler's copy runs instead." : "Runs natively in Claude sessions.",
  registryName: connector.name,
  kind: "claude.ai",
  added: connector.state === "connected" ? "connected" : "needs-auth"
})

const candidateDescription = (candidate: McpImportCandidateView): string => {
  if (candidate.needsSecrets) return "Needs a secret after import."
  if (candidate.needsSignIn) return "Signs in through Jingler after import."
  return "Import to use it in every agent."
}

const candidateEntry = (
  candidate: McpImportCandidateView,
  added: McpConnectorRow | undefined,
  actions: Map<string, CatalogAction>
): ReadonlyArray<McpCatalogEntry> => {
  if (candidate.problem !== null && added === undefined) return []
  const id = `${candidate.source}:${candidate.name}`
  actions.set(id, { kind: "import", source: candidate.source, name: candidate.name })
  return [{
    id,
    origin: HARNESS_ORIGIN[candidate.source],
    displayName: candidate.name,
    iconUrl: null,
    description: candidateDescription(candidate),
    registryName: candidate.target,
    kind: candidate.target.startsWith("http") ? "Remote" : "Local",
    ...(added === undefined ? {} : { added: added.state })
  }]
}

const registryEntry = (
  entry: McpRegistryEntry,
  rowFor: (match: (server: McpServer) => boolean) => McpConnectorRow | undefined,
  actions: Map<string, CatalogAction>
): ReadonlyArray<McpCatalogEntry> => {
  if (entry.entry === null) return []
  const url = entry.entry.type === "remote" ? sameUrl(entry.entry.url) : null
  const added = rowFor((server) => server.name === entry.name || (url !== null && sameUrl(server.target) === url))
  const id = `rg:${entry.registryName}`
  actions.set(id, { kind: "registry", entry })
  return [{
    id,
    origin: "registry",
    displayName: added?.displayName ?? entry.displayName,
    iconUrl: entry.iconUrl,
    description: entry.description,
    registryName: entry.registryName,
    kind: entry.kind,
    ...(added === undefined ? {} : { added: added.state })
  }]
}

/** What a registry add will run or connect to, shown in the confirm step. */
export const registryTarget = (entry: McpRegistryEntry | null): string => {
  if (entry?.entry == null) return ""
  return entry.entry.type === "remote" ? entry.entry.url : entry.entry.command.join(" ")
}

const signedIn = (server: McpServer | undefined): server is McpServer =>
  server?.authKind === "oauth" && server.authState === "ready"

const toggledTools = (disabled: ReadonlyArray<string> | undefined, tool: string, enabled: boolean): ReadonlyArray<string> =>
  enabled ? (disabled ?? []).filter((name) => name !== tool) : [...new Set([...(disabled ?? []), tool])]

function McpPageNotices({ parseError, actionError, registryError, children }: {
  readonly parseError: string | null
  readonly actionError: string | null
  readonly registryError: string | null
  readonly children?: React.ReactNode
}) {
  return (
    <>
      {parseError !== null && (
        <Callout tone="red">mcp.json could not be read: {parseError}. Sessions run without these servers until it parses again.</Callout>
      )}
      {actionError !== null && <div role="alert"><Callout tone="red">{actionError}</Callout></div>}
      {registryError !== null && <Callout tone="red">Registry unavailable: {registryError}</Callout>}
      {children}
    </>
  )
}

/** Settings › MCP: boards 25a–25d on real data. */
export function McpPage(props: McpSettingsProps) {
  const {
    servers, statuses, claudeConnectors = [], parseError, probing, probe, setEnabled, setDisabledTools, signOut,
    remove, add, setApiKey, startAuthorization, reveal, logTail, importCandidates, applyImport,
    openClaudeConnectors, registrySearch, importEntry
  } = props
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)
  const [apiKeyServer, setApiKeyServer] = React.useState<McpServer | null>(null)
  const [logLines, setLogLines] = React.useState<ReadonlyArray<string>>([])
  const [logLoading, setLogLoading] = React.useState(false)
  const [discover, setDiscover] = React.useState(false)
  const [viewKey, setViewKey] = React.useState(0)
  const [query, setQuery] = React.useState("")
  const [candidates, setCandidates] = React.useState<ReadonlyArray<McpImportCandidateView>>([])
  const [registry, setRegistry] = React.useState<ReadonlyArray<McpRegistryEntry>>([])
  const [registryLoading, setRegistryLoading] = React.useState(false)
  const [registryError, setRegistryError] = React.useState<string | null>(null)
  const [catalogNonce, setCatalogNonce] = React.useState(0)
  const [pendingAdd, setPendingAdd] = React.useState<McpRegistryEntry | null>(null)

  const run = (action: () => Promise<void>) => {
    setActionError(null)
    void action().catch((cause) => setActionError(cause instanceof Error ? cause.message : "MCP action failed"))
  }

  // Other harnesses' configs are cheap file reads; load once Discover opens and after each import.
  React.useEffect(() => {
    if (!discover) return
    let live = true
    setCandidates([])
    // Claude needs connectors on to list plugin MCPs; it's slow (`claude mcp list`), so each source lands on its own.
    for (const source of HARNESSES) {
      void importCandidates(source, source === "claude").catch(() => []).then((found) => {
        if (live) setCandidates((current) => [...current.filter((candidate) => candidate.source !== source), ...found])
      })
    }
    return () => { live = false }
  }, [discover, importCandidates, catalogNonce])

  React.useEffect(() => {
    if (!discover || registrySearch === undefined) return
    let live = true
    setRegistryLoading(true)
    const timer = setTimeout(() => {
      void registrySearch(query)
        .then((found) => { if (live) { setRegistry(found); setRegistryError(null) } })
        .catch((cause) => { if (live) setRegistryError(cause instanceof Error ? cause.message : "Registry search failed") })
        .finally(() => { if (live) setRegistryLoading(false) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [discover, query, registrySearch])

  const rows = mcpRows(servers, statuses, claudeConnectors)
  const catalog = mcpCatalog(servers, rows, claudeConnectors, candidates, registry)
  const serverFor = (row: McpConnectorRow) => servers.find((server) => server.name === row.id)
  const openRow = rows.find((row) => row.id === openId) ?? null
  const openServer = openRow === null ? undefined : serverFor(openRow)

  const reconnect = (row: McpConnectorRow) => {
    if (row.source === "claude.ai") { openClaudeConnectors?.(); return }
    const server = serverFor(row)
    if (server === undefined) return
    if (server.authKind === "api-key") setApiKeyServer(server)
    else run(() => startAuthorization(server.name))
  }

  const open = (row: McpConnectorRow) => {
    setOpenId(row.id)
    setLogLines([])
    if (row.source === "claude.ai") return
    setLogLoading(true)
    void logTail(row.id).then((result) => setLogLines(result.lines)).finally(() => setLogLoading(false))
  }

  const addFromRegistry = (entry: McpRegistryEntry) => {
    if (entry.entry === null) return
    const config = entry.entry
    const taken = new Set(servers.map((server) => server.name))
    let name = entry.name
    for (let n = 2; taken.has(name); n += 1) name = `${entry.name}-${n}`
    return add(name, config).then(() => setCatalogNonce((value) => value + 1))
  }

  // Registry entries are untrusted: show what will run before it lands in mcp.json.
  const addFromCatalog = (entry: McpCatalogEntry) => {
    const action = catalog.actions.get(entry.id)
    if (action === undefined) return
    if (action.kind === "registry") { setPendingAdd(action.entry); return }
    run(async () => {
      await applyImport(action.source, [action.name], undefined, action.source === "claude")
      setCatalogNonce((value) => value + 1)
    })
  }

  return (
    <>
      <McpConnectorsView
        key={viewKey}
        rows={rows}
        catalog={catalog.entries}
        catalogLoading={registryLoading && registry.length === 0 && candidates.length === 0}
        initialTab={discover ? "discover" : "yours"}
        onTabChange={(tab) => setDiscover(tab === "discover")}
        onSearch={setQuery}
        onReconnect={reconnect}
        onOpen={open}
        onAddCustom={() => setAddOpen(true)}
        onAddFromCatalog={addFromCatalog}
        headerActions={
          <>
            <Button variant="ghost" size="sm" onClick={probe} disabled={probing || servers.length === 0}>
              {probing ? "Testing…" : "Test connections"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => run(reveal)}>Reveal mcp.json</Button>
          </>
        }
        notices={
          <McpPageNotices parseError={parseError} actionError={actionError} registryError={discover ? registryError : null}>
            {discover ? null : importEntry}
          </McpPageNotices>
        }
      />
      <McpServerDrawer
        row={openRow}
        onOpenChange={(next) => { if (!next) setOpenId(null) }}
        toolNames={statuses?.find((status) => status.name === openId)?.toolNames ?? []}
        disabledTools={openServer?.disabledTools ?? []}
        onToggleTool={(tool, enabled) => {
          if (openServer !== undefined) run(() => setDisabledTools(openServer.name, toggledTools(openServer.disabledTools, tool, enabled)))
        }}
        onEnabledChange={(enabled) => { if (openServer !== undefined) run(() => setEnabled(openServer.name, enabled)) }}
        onReconnect={() => { if (openRow !== null) reconnect(openRow) }}
        onTest={probe}
        onRemove={() => {
          if (openServer === undefined) return
          run(async () => { await remove(openServer.name); setOpenId(null) })
        }}
        {...(signedIn(openServer) ? { onSignOut: () => run(() => signOut(openServer.name)) } : {})}
        logLines={logLines}
        logLoading={logLoading}
      />
      <McpAddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        add={add}
        setApiKey={setApiKey}
        onBrowse={() => { setAddOpen(false); setDiscover(true); setViewKey((value) => value + 1) }}
      />
      <ConfirmDialog
        open={pendingAdd !== null}
        onOpenChange={(next) => { if (!next) setPendingAdd(null) }}
        title={`Add ${pendingAdd?.displayName ?? "server"}?`}
        description={
          <>
            <span>From the MCP registry. Agents can call its tools once it's added.</span>
            <code className="mt-2 block break-all rounded bg-canvas px-2 py-1 font-mono text-[11px] text-text-body">{registryTarget(pendingAdd)}</code>
          </>
        }
        confirmLabel="Add server"
        onConfirm={() => {
          if (pendingAdd === null) return
          setActionError(null)
          return addFromRegistry(pendingAdd)?.catch((cause) => setActionError(cause instanceof Error ? cause.message : "MCP action failed"))
        }}
      />
      <McpApiKeyDialog
        server={apiKeyServer}
        open={apiKeyServer !== null}
        onOpenChange={(next) => { if (!next) setApiKeyServer(null) }}
        setApiKey={setApiKey}
      />
    </>
  )
}
