import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail,
  OAuthClientInfo
} from "@starbase/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as React from "react"
import { Badge } from "../components/badge.js"
import { Callout } from "../components/callout.js"
import { ConnectorLogo } from "../components/connector-logo.js"
import { SearchInput } from "../components/search-input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/select.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import { AUTH_LABEL } from "../lib/connector-labels.js"
import { ConnectorDetail } from "./connector-detail.js"

/**
 * The MCP Connector Center — browse the OpenConnector provider catalog as a grid
 * of logo cards and connect providers (OAuth or API key) in-app.
 *
 * PRESENTATIONAL: it renders from props and calls back on actions, so it lives
 * in `@starbase/ui` (storybookable, no rpc). The desktop renderer wires
 * `useConnectorCenter()` into `ConnectorCenterProps`.
 *
 * The catalog is ~1,100 providers, so the grid is virtualized BY ROW rather than
 * by card: the row count is `ceil(n / columns)` and each virtual item lays its
 * own row out with a plain CSS grid. Virtualizing per-card would need a second
 * axis for no gain, and virtualizing nothing would mount 1,100 `<img>`s.
 *
 * Secrets flow one way — form values go OUT through `onConnect` /
 * `onSetOauthConfig` and are never read back; the props carry no credential
 * (see core `connector.ts`).
 */

type StatusFilter = "all" | "connected" | "not-connected"

/** Every category, or one of the catalog's own ids. */
const ALL_CATEGORIES = "__all__"

/** Card height + gap, in px. Feeds the virtualizer's size estimate. */
const ROW_HEIGHT = 76

/** A service's connections, split by whether they can actually run an action. */
interface ConnectionCounts {
  readonly connected: number
  readonly pending: number
}

/** Shared so every unconnected card gets the same object, not a fresh one. */
const EMPTY_COUNTS: ConnectionCounts = { connected: 0, pending: 0 }

export interface ConnectorCenterProps {
  readonly providers: ReadonlyArray<ConnectorProvider>
  readonly connections: ReadonlyArray<ConnectorConnection>
  readonly oauthConfigs: ReadonlyArray<OAuthClientInfo>
  readonly loading: boolean
  /** A read error (e.g. OpenConnector not configured / unreachable), or null. */
  readonly error: string | null
  /** The opened provider's detail, or null while it loads. */
  readonly detail: ConnectorProviderDetail | null
  readonly detailLoading: boolean
  readonly detailError: string | null
  /** Told which provider's card was opened, so the detail can be fetched lazily. */
  readonly onOpenProvider: (service: string | null) => void
  readonly onConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>,
    connectionName?: string
  ) => Promise<void>
  readonly onDisconnect: (service: string, connectionName: string | null) => Promise<void>
  readonly onSetOauthConfig: (
    provider: string,
    clientId: string,
    clientSecret: string
  ) => Promise<void>
  readonly onStartOauth: (service: string, connectionName?: string) => Promise<void>
  readonly onRefresh: () => void
}

export function ConnectorCenter({
  providers,
  connections,
  oauthConfigs,
  loading,
  error,
  detail,
  detailLoading,
  detailError,
  onOpenProvider,
  onConnect,
  onDisconnect,
  onSetOauthConfig,
  onStartOauth,
  onRefresh
}: ConnectorCenterProps) {
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const [category, setCategory] = React.useState<string>(ALL_CATEGORIES)
  const [active, setActive] = React.useState<ConnectorProvider | null>(null)
  // Declared before `useGridColumns` because that hook measures this element —
  // the grid's width comes from the pane it sits in, not from the window.
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const columns = useGridColumns(scrollRef)

  /**
   * Per service: how many connections are actually USABLE versus merely started.
   *
   * The two are counted apart because they mean different things to the operator.
   * A `pending` connection — an OAuth grant begun but not yet consented — is
   * listed but cannot run an action, so folding it into "connected" would put a
   * green dot and a "Manage" affordance on a provider that does not work yet, and
   * inflate the Connected tab with it.
   */
  const connectionCount = React.useMemo(() => {
    const counts = new Map<string, { connected: number; pending: number }>()
    // Mutated in place while building, then read as a readonly ConnectionCounts.
    for (const c of connections) {
      const entry = counts.get(c.service) ?? { connected: 0, pending: 0 }
      if (c.status === "pending") entry.pending += 1
      else entry.connected += 1
      counts.set(c.service, entry)
    }
    return counts
  }, [connections])

  /** A service is "connected" only when at least one connection is usable. */
  const isConnected = React.useCallback(
    (service: string) => (connectionCount.get(service)?.connected ?? 0) > 0,
    [connectionCount]
  )

  const categories = React.useMemo(() => {
    const seen = new Set<string>()
    for (const p of providers) for (const c of p.categories) seen.add(c)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [providers])

  /** Status counts are over the CATEGORY+SEARCH result, so the tabs describe
      what switching to them would actually show, not the whole catalog. */
  const scoped = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return providers.filter((p) => {
      if (category !== ALL_CATEGORIES && !p.categories.includes(category)) return false
      if (q.length === 0) return true
      return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    })
  }, [providers, query, category])

  const connectedCount = React.useMemo(
    () => scoped.filter((p) => isConnected(p.id)).length,
    [scoped, isConnected]
  )

  const filtered = React.useMemo(() => {
    if (status === "all") return scoped
    const wantConnected = status === "connected"
    return scoped.filter((p) => isConnected(p.id) === wantConnected)
  }, [scoped, status, isConnected])

  const rowCount = Math.ceil(filtered.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3
  })

  const open = (provider: ConnectorProvider) => {
    setActive(provider)
    onOpenProvider(provider.id)
  }
  const close = () => {
    setActive(null)
    onOpenProvider(null)
  }

  const activeConnections = React.useMemo(
    () => (active ? connections.filter((c) => c.service === active.id) : []),
    [active, connections]
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-text-bright">Connector Center</h3>
          <p className="mt-0.5 text-[11px] text-dim">
            Connect providers once — every agent draws them from the shared OpenConnector.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="flex-none rounded-md border border-line bg-panel px-2.5 py-1 text-[11px] text-text hover:border-line-strong hover:bg-surface"
        >
          Refresh
        </button>
      </div>

      {error && providers.length === 0 ? <Callout tone="blue">{error}</Callout> : null}

      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={loading ? "Loading providers…" : `Search ${providers.length} providers…`}
        aria-label="Search providers"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          value={status}
          onChange={setStatus}
          items={[
            { value: "all", label: `All ${scoped.length}` },
            { value: "connected", label: `Connected ${connectedCount}` },
            { value: "not-connected", label: `Not connected ${scoped.length - connectedCount}` }
          ]}
        />
        {categories.length > 0 ? (
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Filter by category" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {/* A named region: "GitHub" is also a Settings nav entry, so the catalog
          needs to be addressable on its own — by a screen reader and by a test
          alike. */}
      <div
        ref={scrollRef}
        role="group"
        aria-label="Provider catalog"
        className="max-h-[420px] overflow-y-auto rounded-lg border border-line p-2"
      >
        {filtered.length === 0 && !loading ? (
          <div className="px-3 py-8 text-center text-[12px] text-dim">
            {query.trim().length > 0
              ? `No providers match “${query}”.`
              : "No providers match these filters."}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const start = row.index * columns
              return (
                <div
                  key={row.key}
                  className="grid gap-2"
                  style={{
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_HEIGHT,
                    transform: `translateY(${row.start}px)`
                  }}
                >
                  {filtered.slice(start, start + columns).map((provider) => (
                    <ConnectorCard
                      key={provider.id}
                      provider={provider}
                      counts={connectionCount.get(provider.id) ?? EMPTY_COUNTS}
                      onOpen={() => open(provider)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ConnectorDetail
        provider={active}
        detail={detail}
        detailLoading={detailLoading}
        detailError={detailError}
        connections={activeConnections}
        oauthInfo={active ? oauthConfigs.find((o) => o.provider === active.id) : undefined}
        onClose={close}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onSetOauthConfig={onSetOauthConfig}
        onStartOauth={onStartOauth}
      />
    </div>
  )
}

/**
 * How many cards fit across a container this wide.
 *
 * Thresholds are derived from a ~280px comfortable card and the grid's 8px gap
 * (`gap-2`): n columns need `n * 280 + (n - 1) * 8`. Exported for the test —
 * the arithmetic is the part worth pinning; the observer around it is plumbing.
 */
export const columnsForWidth = (width: number): number =>
  width < 2 * 280 + 8 ? 1 : width < 3 * 280 + 16 ? 2 : 3

/**
 * Column count from the SCROLL CONTAINER's width — not the window's.
 *
 * The distinction is load-bearing: Settings puts a fixed 216px nav rail beside
 * this pane, so the catalog is always ~240px narrower than the viewport. Measured
 * against `document.documentElement` the breakpoints fire early by that much and
 * a 3-up is chosen for a container that fits 2, cramming the cards — and the
 * row-slice maths downstream is built on the same wrong number.
 *
 * The virtualizer needs this as state rather than a CSS `auto-fill`, because it
 * slices `filtered` into rows of exactly `columns` and the JS has to know.
 */
function useGridColumns(ref: React.RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = React.useState(3)
  React.useEffect(() => {
    const el = ref.current
    // jsdom and Storybook's docs frame have no ResizeObserver in some setups;
    // the 3-up default is a fine answer when we can't measure.
    if (el === null || typeof ResizeObserver === "undefined") return
    // Fires once on observe with the current size, so the first paint is measured
    // rather than guessed.
    const observer = new ResizeObserver(() => setColumns(columnsForWidth(el.clientWidth)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return columns
}

function ConnectorCard({
  provider,
  counts,
  onOpen
}: {
  provider: ConnectorProvider
  counts: ConnectionCounts
  onOpen: () => void
}) {
  const connected = counts.connected > 0
  // Pending is only worth surfacing when nothing usable exists yet. A provider
  // with a working connection AND a half-finished second one reads as connected,
  // because it is — the operator can run actions against it right now.
  const pending = !connected && counts.pending > 0
  return (
    <button
      type="button"
      onClick={onOpen}
      // The card's text is name + id + category + auth chips; the provider's
      // NAME is what the operator is actually picking.
      aria-label={provider.name}
      className={cn(
        "flex h-[68px] w-full items-center gap-2.5 rounded-lg border bg-sunken px-3 text-left transition-colors",
        connected
          ? "border-green/30 hover:border-green/50"
          : pending
            ? "border-yellow/30 hover:border-yellow/50"
            : "border-line hover:border-line-strong",
        "hover:bg-hover"
      )}
    >
      <ConnectorLogo
        homepageUrl={provider.homepageUrl}
        iconUrl={provider.icon}
        name={provider.name}
        size={30}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-text-bright">
            {provider.name}
          </span>
          {counts.connected > 1 ? (
            <Badge tone="green" size="xs">
              {counts.connected}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-1">
          {provider.authTypes.slice(0, 2).map((t) => (
            <Badge key={t} tone={t === "no_auth" ? "green" : "neutral"} size="xs">
              {AUTH_LABEL[t]}
            </Badge>
          ))}
          {provider.categories[0] ? (
            <span className="truncate text-[10px] text-dim">{provider.categories[0]}</span>
          ) : null}
        </div>
      </div>
      <span className="flex flex-none items-center gap-1.5">
        <StatusDot
          tone={connected ? "bg-green" : pending ? "bg-yellow" : "bg-line-strong"}
          size={7}
        />
        <span
          className={cn(
            "text-[11px]",
            connected ? "text-green" : pending ? "text-yellow" : "text-blue"
          )}
        >
          {connected ? "Manage" : pending ? "Pending" : "Connect"}
        </span>
      </span>
    </button>
  )
}
