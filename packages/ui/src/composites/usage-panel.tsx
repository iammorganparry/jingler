import { Spin } from "../components/spin.js"
import type {
  AgentRuntimeId,
  ModelPerformanceSortKey,
  ProviderSpend,
  ProviderUsage,
  Usage,
  UsageFact,
  UsageReport,
  UsageReportGroup,
  UsageStatus,
  UsageWindow
} from "@jingler/core"
import { filterUsageFacts, modelDetailFromFacts, sortModelPerformance, usageReportFromFacts } from "@jingler/core"
import { Download, RefreshCw } from "lucide-react"
import { useMemo, useState } from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { FilterChips } from "../components/filter-chips.js"
import { KpiTile, StackedMiniBar } from "../components/kpi-tile.js"
import { ModelPerformanceTable } from "../components/model-performance-table.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { providerAuthRouteLabel } from "../lib/provider-connection-labels.js"
import { ModelDetailDrawer } from "./model-detail-drawer.js"

const fmtReset = (iso: string | null): string => {
  if (!iso) return "—"
  const d = new Date(iso)
  const day = d.toLocaleDateString(undefined, { weekday: "short" })
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `Resets ${day} ${time}`
}

const fmtUsed = (u: number | null): string => (u == null ? "—" : `${Math.round(u)}% used`)

export const fmtUpdated = (iso: string | null): string => {
  if (!iso) return "never"
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return "less than a minute ago"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} hr ago`
  return `${Math.floor(s / 86_400)} days ago`
}

const barColor = (status: UsageStatus): string =>
  status === "limited"
    ? "var(--sb-red)"
    : status === "nearing"
      ? "var(--sb-yellow)"
      : "var(--sb-blue)"

function WindowRow({ window: w }: { window: UsageWindow }) {
  const pct = w.utilization == null ? 0 : Math.min(100, Math.max(0, w.utilization))
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="w-[158px] flex-none">
        <div className="text-[12.5px] text-text-body">{w.label}</div>
        <div className="mt-0.5 text-[10.5px] text-muted-foreground">{fmtReset(w.resetsAt)}</div>
      </div>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full w-full origin-left rounded-full transition-transform"
          style={{ transform: `scaleX(${pct / 100})`, background: barColor(w.status) }}
        />
      </div>
      <span className="w-[66px] flex-none text-right font-mono text-[11px] text-text-body">
        {fmtUsed(w.utilization)}
      </span>
    </div>
  )
}

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** API-priced plans bill per token, so usage is spend — there are no windows or percentage bars. */
export function SpendRows({ spend }: { spend: ProviderSpend }) {
  const rows = [
    ["Last session", spend.lastSession],
    ["Today", spend.today],
    ["This month", spend.month]
  ] as const
  return (
    <div data-testid="spend-rows">
      {rows.map(([label, totals]) => (
        <div key={label} className="flex items-center justify-between py-2">
          <span className="text-[12.5px] text-text-body">{label}</span>
          <span className="font-mono text-[11px] text-text-body">
            {totals === null ? "—" : `$${totals.costUsd.toFixed(2)} · ${fmtTokens(totals.tokens)} tokens`}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ProviderSection({ provider: p }: { provider: ProviderUsage }) {
  const route = p.authKind ? providerAuthRouteLabel(p.authKind) : null
  return (
    <div className="border-b border-hairline py-[18px] last:border-0">
      <div className="mb-3 flex items-center gap-[9px]">
        <ProviderIcon providerId={p.providerId} size={14} />
        <span className="text-[14px] font-semibold text-text-bright">{p.name}</span>
        {p.plan && (
          <Badge tone="neutral" size="sm">
            {p.plan}
          </Badge>
        )}
      </div>
      {route && (
        <div data-testid="usage-route-badges" className="mb-3 flex items-center gap-2 overflow-x-auto">
          <Badge tone="neutral" size="sm" className="max-w-[180px] truncate">{route}</Badge>
          <Badge tone="neutral" size="sm" className="max-w-[160px] truncate">Billing: {p.billingRoute ?? "unconfirmed"}</Badge>
          <Badge tone="neutral" size="sm" className="max-w-[160px] truncate">Target: {p.targetId}</Badge>
          <Badge tone="neutral" size="sm" className="max-w-[140px] truncate">Status: {p.authStatus}</Badge>
        </div>
      )}
      {(p.quotaLabel || p.rateLimitLabel) && (
        <div className="mb-2 text-[11px] text-text-body">
          {[p.quotaLabel, p.rateLimitLabel].filter(Boolean).join(" · ")}
        </div>
      )}
      {p.spend ? (
        <SpendRows spend={p.spend} />
      ) : p.available ? (
        p.windows.map((w) => <WindowRow key={w.label} window={w} />)
      ) : (
        <div className="text-[12px] text-muted-foreground">
          Usage data isn&apos;t available for this connection yet.
          {p.unavailableReason && (
            <div className="mt-1 text-[11px] text-dim">{p.unavailableReason}</div>
          )}
        </div>
      )}
    </div>
  )
}

type Groups = UsageReport["groups"]

const sumBy = (groups: Groups, pick: (group: Groups[number]) => number): number =>
  groups.reduce((sum, group) => sum + pick(group), 0)

/** Run-weighted success rate over groups that report one; null when none do (never invented). */
const successRateOf = (groups: Groups): number | null => {
  const rated = groups.filter((group) => group.successRate !== null)
  const runs = sumBy(rated, (group) => group.runCount)
  return runs === 0 ? null : sumBy(rated, (group) => (group.successRate ?? 0) * group.runCount) / runs
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

/** Runs, Success rate, Tokens and Known cost; cost is "partial" unless every run priced. */
function KpiStrip({ groups }: { groups: Groups }) {
  const runs = sumBy(groups, (group) => group.runCount)
  const success = successRateOf(groups)
  const coverage = runs === 0 ? 0 : sumBy(groups, (group) => group.costCoverage * group.runCount) / runs
  const tokenSplit = [
    sumBy(groups, (group) => group.inputTokens),
    sumBy(groups, (group) => group.outputTokens),
    sumBy(groups, (group) => group.cacheReadTokens + group.cacheWriteTokens),
    sumBy(groups, (group) => group.reasoningTokens)
  ]
  return (
    <div className="@container mb-3">
    <div className="grid grid-cols-2 gap-2 @[560px]:grid-cols-4" data-testid="usage-kpis">
      <KpiTile label="Runs" value={runs} />
      <KpiTile label="Success rate" value={success === null ? null : percent(success)} />
      <KpiTile
        label="Tokens"
        value={sumBy(groups, (group) => group.totalTokens).toLocaleString()}
        delta={<StackedMiniBar label="Tokens: input, output, cache, reasoning" values={tokenSplit} width={80} />}
      />
      <KpiTile
        label="Known cost"
        value={`$${sumBy(groups, (group) => group.knownCostUsd).toFixed(2)}`}
        partial={coverage < 1}
        delta={coverage < 1 ? `cost known for ${percent(coverage)} of runs` : undefined}
      />
    </div>
    </div>
  )
}

const runtimeFilterOptions: ReadonlyArray<{ value: "all" | AgentRuntimeId; label: string }> = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "Opencode" },
  { value: "pi", label: "Pi" }
]

const rangeDays = { "7d": 7, "30d": 30 } as const
type RangeValue = "all" | keyof typeof rangeDays
const rangeOptions: ReadonlyArray<{ value: RangeValue; label: string }> = [
  { value: "all", label: "All time" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
]

/**
 * The execution report's filter row, KPI strip and sortable per-model table. Filtering
 * re-aggregates the underlying facts client-side; project filtering is skipped until
 * `UsageFact` carries a project id (not yet recorded at the accounting boundary).
 */
export function ReportSection({ report, onExport }: { report: UsageReport; onExport?: () => Promise<void> | void }) {
  const [runtimeFilter, setRuntimeFilter] = useState<"all" | AgentRuntimeId>("all")
  const [sortBy, setSortBy] = useState<ModelPerformanceSortKey>("runCount")
  const [direction, setDirection] = useState<"asc" | "desc">("desc")
  const [selectedGroup, setSelectedGroup] = useState<UsageReportGroup | null>(null)

  const [range, setRange] = useState<RangeValue>("all")

  const filteredFacts = useMemo<ReadonlyArray<UsageFact>>(
    () =>
      filterUsageFacts(report.facts, {
        ...(runtimeFilter === "all" ? {} : { runtimeId: runtimeFilter }),
        ...(range === "all" ? {} : { from: new Date(Date.now() - rangeDays[range] * 86_400_000).toISOString() })
      }),
    [report.facts, runtimeFilter, range]
  )
  const filteredGroups = useMemo(() => usageReportFromFacts(filteredFacts).groups, [filteredFacts])
  const sortedGroups = useMemo(
    () => sortModelPerformance(filteredGroups, sortBy, direction),
    [filteredGroups, sortBy, direction]
  )
  const selectedDetail = useMemo(
    () => (selectedGroup ? modelDetailFromFacts(filteredFacts, selectedGroup) : null),
    [filteredFacts, selectedGroup]
  )

  const onSort = (key: ModelPerformanceSortKey) => {
    if (key === sortBy) setDirection(direction === "asc" ? "desc" : "asc")
    else {
      setSortBy(key)
      setDirection("desc")
    }
  }

  return (
    <div className="border-t border-hairline py-[14px]">
      <div data-testid="usage-report-header" className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold text-text-bright">Execution report</div>
        {onExport && (
          <Button size="sm" variant="ghost" onClick={() => void onExport()}>
            <Download size={12} />
            Export JSON
          </Button>
        )}
      </div>
      <div data-testid="usage-report-filters" className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <FilterChips options={rangeOptions} value={range} onChange={setRange} ariaLabel="Filter by date range" />
        <FilterChips options={runtimeFilterOptions} value={runtimeFilter} onChange={setRuntimeFilter} ariaLabel="Filter by runtime" />
      </div>
      {filteredGroups.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">No completed parent or child runs recorded.</div>
      ) : (
        <>
          <KpiStrip groups={filteredGroups} />
          <ModelPerformanceTable
            groups={sortedGroups}
            sortBy={sortBy}
            direction={direction}
            onSort={onSort}
            onRowClick={setSelectedGroup}
          />
        </>
      )}
      <ModelDetailDrawer
        open={selectedGroup !== null}
        detail={selectedDetail}
        onOpenChange={(open) => !open && setSelectedGroup(null)}
      />
    </div>
  )
}

/** Per-provider limits (or the loading / empty state) followed by the execution report. Shared by the modal and Settings → Usage. */
export function UsageBody({
  usage,
  report,
  loading = false,
  onExport
}: {
  usage?: Usage | null
  report?: UsageReport | null
  loading?: boolean
  onExport?: () => Promise<void> | void
}) {
  const providers = usage?.providers ?? []
  return (
    <>
      {providers.length > 0 ? (
        providers.map((p) => <ProviderSection key={p.connectionId ?? p.name} provider={p} />)
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Spin><RefreshCw size={13} /></Spin>
          Reading plan usage…
        </div>
      ) : (
        <div className="py-3 text-[12px] text-muted-foreground">
          No provider connections are configured on this machine.
        </div>
      )}
      {report && <ReportSection report={report} onExport={onExport} />}
    </>
  )
}
