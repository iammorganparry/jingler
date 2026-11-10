import { ChevronRight, Plus } from "lucide-react"
import * as React from "react"
import { Badge } from "../components/badge.js"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"
import { FilterChips } from "../components/filter-chips.js"
import { SearchField } from "../components/search-input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import { McpBrand } from "./mcp-settings.js"

/**
 * Settings › MCP (boards 25a/25b) and the composer `+ › MCP` submenu (25e).
 * One list for every source; claude.ai rows reconnect on claude.ai, the rest through Jingler.
 */
export type McpSource = "jingler" | "claude.ai" | "plugin"
export type McpRowState = "connected" | "needs-auth" | "failed" | "pending" | "local-only"

export interface McpConnectorRow {
  readonly id: string
  readonly displayName: string
  readonly iconUrl: string | null
  /** URL host/path or command; plugin rows use a "Provided by …" note instead. */
  readonly target: string
  readonly note?: string
  readonly source: McpSource
  /** Which agents can call it, e.g. "All agents" or "Claude". */
  readonly agents: string
  readonly state: McpRowState
  readonly toolCount: number | null
  /** On for this chat (composer submenu only). */
  readonly enabled: boolean
}

/** Where a Discover entry comes from: another harness on this machine, or the official registry. */
export type McpCatalogOrigin = "claude.ai" | "claude-code" | "codex" | "opencode" | "registry"

const ORIGIN_ORDER: ReadonlyArray<McpCatalogOrigin> = ["claude.ai", "claude-code", "codex", "opencode", "registry"]
const ORIGIN_LABEL: Record<McpCatalogOrigin, string> = {
  "claude.ai": "claude.ai",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  registry: "Registry"
}
const ORIGIN_HINT: Record<McpCatalogOrigin, string> = {
  "claude.ai": "Your claude.ai and org connectors. Run natively in Claude sessions; sign-in lives on claude.ai.",
  "claude-code": "Servers and plugins from ~/.claude. Import to use them in every agent.",
  codex: "Servers from ~/.codex/config.toml. Import to use them in every agent.",
  opencode: "Servers from opencode.json. Import to use them in every agent.",
  registry: "registry.modelcontextprotocol.io"
}

export interface McpCatalogEntry {
  readonly id: string
  readonly origin: McpCatalogOrigin
  readonly displayName: string
  readonly iconUrl: string | null
  readonly description: string
  /** Registry id, e.g. "io.sentry/mcp". */
  readonly registryName: string
  readonly kind: string
  /** Set when the entry is already in Yours. */
  readonly added?: McpRowState
}

const SOURCE_LABEL: Record<McpSource, string> = { jingler: "Jingler", "claude.ai": "claude.ai", plugin: "Plugin" }
const STATE_TONE: Record<McpRowState, string> = {
  connected: "bg-green",
  "needs-auth": "bg-yellow",
  failed: "bg-red",
  pending: "bg-line-strong",
  "local-only": "bg-line-strong"
}
const STATE_LABEL: Record<McpRowState, string> = {
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  pending: "Connects in sessions",
  "local-only": "Only in local sessions"
}

type Filter = "all" | "needs-auth" | McpSource

const rowMatches = (row: McpConnectorRow, filter: Filter, q: string): boolean =>
  (filter === "all" || (filter === "needs-auth" ? row.state === "needs-auth" : row.source === filter)) &&
  (q === "" || row.displayName.toLowerCase().includes(q))

function StatusCell({ row, onReconnect }: { readonly row: McpConnectorRow; readonly onReconnect: (row: McpConnectorRow) => void }) {
  if (row.state === "needs-auth") {
    return (
      <div className="flex items-center gap-2">
        <StatusDot tone={STATE_TONE[row.state]} size={6} />
        <Button variant="secondary" size="sm" onClick={() => onReconnect(row)} aria-label={`Reconnect ${row.displayName}`}>
          Reconnect
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <StatusDot tone={STATE_TONE[row.state]} size={6} />
      {row.state === "connected" && row.toolCount !== null ? `${row.toolCount} tools` : STATE_LABEL[row.state]}
    </div>
  )
}

function ServerTable({
  rows,
  onReconnect,
  onOpen
}: {
  readonly rows: ReadonlyArray<McpConnectorRow>
  readonly onReconnect: (row: McpConnectorRow) => void
  readonly onOpen: (row: McpConnectorRow) => void
}) {
  return (
    <div role="table" aria-label="MCP servers" className="overflow-hidden rounded-xl border border-line">
      <div role="row" className="flex items-center gap-3 border-b border-line bg-sunken px-4 py-2 text-[11px] uppercase tracking-[0.06em] text-dim">
        <span role="columnheader" className="min-w-0 flex-1">Server</span>
        <span role="columnheader" className="w-24">Source</span>
        <span role="columnheader" className="w-28">Agents</span>
        <span role="columnheader" className="w-40">Status</span>
      </div>
      {rows.map((row) => (
        <div role="row" key={row.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-hover">
          <span role="cell" className="flex min-w-0 flex-1">
            <button type="button" aria-label={`Open ${row.displayName} details`} onClick={() => onOpen(row)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <McpBrand server={row} compact />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-text-bright">{row.displayName}</span>
                <span className={`block truncate text-[11px] text-dim ${row.note ? "" : "font-mono"}`}>{row.note ?? row.target}</span>
              </span>
            </button>
          </span>
          <span role="cell" className="w-24"><Badge size="xs">{SOURCE_LABEL[row.source]}</Badge></span>
          <span role="cell" className="w-28 truncate text-[12px] text-muted-foreground">{row.agents}</span>
          <span role="cell" className="w-40"><StatusCell row={row} onReconnect={onReconnect} /></span>
        </div>
      ))}
    </div>
  )
}

function YoursPanel({
  rows,
  visible,
  needsAuth,
  tools,
  onShowNeedsAuth,
  onBrowse,
  onAddCustom,
  onReconnect,
  onOpen
}: {
  readonly rows: ReadonlyArray<McpConnectorRow>
  readonly visible: ReadonlyArray<McpConnectorRow>
  readonly needsAuth: number
  readonly tools: number
  readonly onShowNeedsAuth: () => void
  readonly onBrowse: () => void
  readonly onAddCustom: () => void
  readonly onReconnect: (row: McpConnectorRow) => void
  readonly onOpen: (row: McpConnectorRow) => void
}) {
  const list = rows.length === 0 ? (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-line px-4 py-10">
      <p className="text-[13px] text-muted-foreground">No servers configured yet.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onBrowse}>Browse servers</Button>
        <Button variant="secondary" size="sm" onClick={onAddCustom}>Add server</Button>
      </div>
    </div>
  ) : visible.length === 0
    ? <p className="rounded-xl border border-line px-4 py-10 text-center text-[13px] text-muted-foreground">No servers match.</p>
    : <ServerTable rows={visible} onReconnect={onReconnect} onOpen={onOpen} />
  return (
    <>
      {needsAuth > 0 && (
        <BannerShell
          placement="card"
          icon={<StatusDot tone="bg-yellow" size={8} />}
          actions={[<Button key="show" variant="ghost" size="sm" onClick={onShowNeedsAuth}>Show only these</Button>]}
        >
          {needsAuth} server{needsAuth === 1 ? " needs" : "s need"} sign-in. Their tools are skipped until you reconnect.
        </BannerShell>
      )}
      {list}
      {tools > 80 && (
        <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-2.5 text-[12px] text-muted-foreground">
          {tools} tools enabled. Models pick tools less reliably past ~80 — turn off the ones you don't need in each server's details.
        </p>
      )}
    </>
  )
}

function CatalogCard({ entry, onAdd, onReconnect }: { readonly entry: McpCatalogEntry; readonly onAdd: (entry: McpCatalogEntry) => void; readonly onReconnect: (entry: McpCatalogEntry) => void }) {
  const harness = entry.origin !== "registry" && entry.origin !== "claude.ai"
  const action = entry.added === "needs-auth"
    ? <Button variant="secondary" size="sm" onClick={() => onReconnect(entry)}>{entry.origin === "claude.ai" ? "Connect" : "Reconnect"}</Button>
    : entry.added !== undefined
      ? <span className="text-[11px] text-green">{entry.origin === "claude.ai" ? "Native" : "Added"}</span>
      : harness
        ? <Button variant="secondary" size="sm" aria-label={`Import ${entry.displayName}`} onClick={() => onAdd(entry)}>Import</Button>
        : <Button variant="secondary" size="icon" aria-label={`Add ${entry.displayName}`} onClick={() => onAdd(entry)}><Plus size={14} /></Button>
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-panel p-3.5">
      <McpBrand server={entry} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-text-bright">{entry.displayName}</span>
          <Badge size="xs">{entry.kind}</Badge>
        </div>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{entry.description}</p>
        <span className="truncate font-mono text-[11px] text-dim">{entry.registryName}</span>
      </div>
      <div className="flex-none">{action}</div>
    </div>
  )
}

export interface McpConnectorsViewProps {
  readonly rows: ReadonlyArray<McpConnectorRow>
  readonly catalog: ReadonlyArray<McpCatalogEntry>
  readonly catalogLoading?: boolean
  readonly initialTab?: "yours" | "discover"
  readonly onReconnect: (row: McpConnectorRow) => void
  readonly onOpen: (row: McpConnectorRow) => void
  readonly onAddCustom: () => void
  readonly onAddFromCatalog: (entry: McpCatalogEntry) => void
  /** Extra header buttons (Test connections, Reveal mcp.json). */
  readonly headerActions?: React.ReactNode
  /** Notices under the toolbar (parse errors, action errors). */
  readonly notices?: React.ReactNode
  /** Called with the Discover search text so the host can query the registry. */
  readonly onSearch?: (query: string) => void
  readonly onTabChange?: (tab: "yours" | "discover") => void
}

export function McpConnectorsView({
  rows,
  catalog,
  catalogLoading = false,
  initialTab = "yours",
  onReconnect,
  onOpen,
  onAddCustom,
  onAddFromCatalog,
  headerActions,
  notices,
  onSearch,
  onTabChange
}: McpConnectorsViewProps) {
  const [tab, setTabState] = React.useState(initialTab)
  const [filter, setFilter] = React.useState<Filter>("all")
  const [query, setQueryState] = React.useState("")
  const setQuery = (next: string) => { setQueryState(next); onSearch?.(next) }
  // Each tab searches a different list; carrying the text over hides servers in Yours.
  const setTab = (next: "yours" | "discover") => { setTabState(next); setQuery(""); onTabChange?.(next) }
  const needsAuth = rows.filter((row) => row.state === "needs-auth")
  const count = (match: (row: McpConnectorRow) => boolean) => rows.filter(match).length
  const q = query.trim().toLowerCase()
  const visible = rows.filter((row) => rowMatches(row, filter, q))
  const entries = catalog.filter((entry) => q === "" || `${entry.displayName} ${entry.description}`.toLowerCase().includes(q))
  const tools = rows.reduce((sum, row) => sum + (row.toolCount ?? 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-text-bright">MCP</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {tab === "yours"
              ? `Tools your agents can call. ${rows.length} servers · ${tools} tools`
              : "Servers from your other agents and the official MCP registry. Added servers work in every agent."}
          </p>
        </div>
        {headerActions && <div className="flex flex-none items-center gap-2">{headerActions}</div>}
      </div>
      {notices}
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl
          aria-label="MCP view"
          items={[{ value: "yours", label: "Yours" }, { value: "discover", label: "Discover" }]}
          value={tab}
          onChange={setTab}
        />
        {tab === "yours" && (
          <FilterChips<Filter>
            ariaLabel="Filter servers"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: rows.length },
              { value: "needs-auth", label: "Needs sign-in", count: needsAuth.length },
              { value: "claude.ai", label: "claude.ai", count: count((row) => row.source === "claude.ai") },
              { value: "plugin", label: "Plugin", count: count((row) => row.source === "plugin") }
            ]}
          />
        )}
        <span className="flex-1" />
        <SearchField value={query} onChange={setQuery} placeholder={tab === "yours" ? "Search servers" : "Search registry"} className="w-56" />
        <Button size="sm" onClick={onAddCustom}><Plus size={12} /> Add server</Button>
      </div>

      {tab === "yours" ? (
        <YoursPanel
          rows={rows}
          visible={visible}
          needsAuth={needsAuth.length}
          tools={tools}
          onShowNeedsAuth={() => setFilter("needs-auth")}
          onBrowse={() => setTab("discover")}
          onAddCustom={onAddCustom}
          onReconnect={onReconnect}
          onOpen={onOpen}
        />
      ) : catalogLoading ? (
        <p className="text-[12px] text-muted-foreground">Loading the registry…</p>
      ) : (
        <div className="flex flex-col gap-6">
          {ORIGIN_ORDER.map((origin) => {
            const group = entries.filter((entry) => entry.origin === origin)
            if (group.length === 0) return null
            return (
              <section key={origin} aria-label={`${ORIGIN_LABEL[origin]} servers`} className="flex flex-col gap-2.5">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[15px] font-semibold text-text-bright">{ORIGIN_LABEL[origin]}</h3>
                  <Badge tone="count" size="xs">{group.length}</Badge>
                  <span className="truncate text-[11px] text-dim">{ORIGIN_HINT[origin]}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {group.map((entry) => (
                    <CatalogCard
                      key={entry.id}
                      entry={entry}
                      onAdd={onAddFromCatalog}
                      onReconnect={(added) => {
                        const row = rows.find((candidate) => candidate.displayName === added.displayName)
                        if (row) onReconnect(row)
                      }}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface McpComposerMenuProps {
  readonly rows: ReadonlyArray<McpConnectorRow>
  readonly onToggle: (row: McpConnectorRow, enabled: boolean) => void
  readonly onReconnect: (row: McpConnectorRow) => void
  readonly onBrowse: () => void
  readonly onManage: () => void
  /** Reconnect rows shown before collapsing into "+N more". */
  readonly reconnectLimit?: number
  /** Rendered inside another popover: no own border, shadow or width. */
  readonly embedded?: boolean
}

/** Composer `+ › MCP` submenu: per-chat toggles, then servers that need sign-in. */
export function McpComposerMenu({ rows, onToggle, onReconnect, onBrowse, onManage, reconnectLimit = 4, embedded = false }: McpComposerMenuProps) {
  const ready = rows.filter((row) => row.state !== "needs-auth")
  const blocked = rows.filter((row) => row.state === "needs-auth")
  const extra = blocked.length - reconnectLimit
  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-text-bright outline-none hover:bg-hover focus-visible:bg-hover"
  return (
    <div role="menu" aria-label="MCP servers" className={embedded ? "flex flex-col" : "flex w-[340px] flex-col rounded-xl border border-line bg-panel p-1.5 shadow-[0_12px_32px_var(--sb-shadow-strong)]"}>
      <button type="button" role="menuitem" className={item} onClick={onBrowse}>Browse MCP servers</button>
      <button type="button" role="menuitem" className={item} onClick={onManage}>Manage MCP servers</button>
      <div role="separator" className="my-1 h-px bg-line" />
      {ready.map((row) => (
        <div key={row.id} className="flex items-center gap-2 rounded-md px-2.5 py-1.5">
          <McpBrand server={row} compact />
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[13px] ${row.state === "local-only" ? "text-dim" : "text-text-bright"}`}>{row.displayName}</span>
            {row.state === "local-only" && <span className="block text-[11px] text-dim">{STATE_LABEL[row.state]}</span>}
          </span>
          {row.state !== "local-only" && (
            <Toggle size="sm" checked={row.enabled} onCheckedChange={(checked) => onToggle(row, checked)} aria-label={`Use ${row.displayName} in this chat`} />
          )}
        </div>
      ))}
      {blocked.slice(0, reconnectLimit).map((row) => (
        <button key={row.id} type="button" role="menuitem" className={item} onClick={() => onReconnect(row)}>
          <McpBrand server={row} compact />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{row.displayName}</span>
            <span className="block text-[11px] text-yellow">Reconnect</span>
          </span>
        </button>
      ))}
      {extra > 0 && (
        <button type="button" role="menuitem" className={`${item} text-[12px] text-muted-foreground`} onClick={onManage}>
          +{extra} more need sign-in <ChevronRight size={12} />
        </button>
      )}
    </div>
  )
}
