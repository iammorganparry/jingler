import type { MemoryDashboardSummary } from "@jingler/contracts"
import {
  Activity,
  AlertTriangle,
  BookOpen,
  GitFork,
  Quote,
  RefreshCw
} from "lucide-react"
import type { ReactNode } from "react"

export type MemorySubview = "dashboard" | "map" | "wiki" | "analytics"

export interface MemoryDeepLink {
  readonly view: MemorySubview
  readonly filter?: string
}

export interface MemoryDashboardProps {
  summary: MemoryDashboardSummary | null
  loading?: boolean
  error?: string | null
  onNavigate: (target: MemoryDeepLink) => void
  onRetry?: () => void
}

const percent = (value: number): string => `${Math.round(value * 100)}%`

function MetricCard({
  title,
  value,
  detail,
  icon,
  onClick
}: {
  title: string
  value: string
  detail: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group min-h-32 rounded-xl border border-line bg-panel p-4 text-left outline-none transition-colors hover:border-line-strong hover:bg-surface/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mb-5 flex items-center justify-between text-muted-foreground">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">{title}</span>
        {icon}
      </span>
      <strong className="block text-2xl font-semibold tabular-nums text-text-bright">{value}</strong>
      <span className="mt-1.5 block text-[11.5px] leading-5 text-muted-foreground">{detail}</span>
    </button>
  )
}

export function MemoryDashboard({
  summary,
  loading = false,
  error = null,
  onNavigate,
  onRetry
}: MemoryDashboardProps) {
  if (loading && summary === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground" role="status">
        <RefreshCw className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
        Loading organization memory summary…
      </div>
    )
  }

  if (error && summary === null) {
    return (
      <div className="m-auto max-w-md rounded-xl border border-red/50 bg-panel p-5 text-[12px] text-text">
        <p className="m-0">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md bg-surface px-3 py-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        )}
      </div>
    )
  }

  if (summary === null) return null
  const findings =
    summary.health.orphanPages + summary.health.brokenLinks + summary.health.contradictions
  const latestGrowth = summary.growth.daily.slice(-7)
  const maxGrowth = Math.max(1, ...latestGrowth.map((day) => day.pages + day.revisions))

  return (
    <section className="min-h-0 flex-1 overflow-auto p-5" aria-labelledby="memory-dashboard-title">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue">Team knowledge</p>
          <h1 id="memory-dashboard-title" className="m-0 mt-1 text-xl font-semibold text-text-bright">
            Memory overview
          </h1>
          <p className="m-0 mt-1 text-[12px] text-muted-foreground">
            Accepted evidence and privacy-safe activity as of {new Date(summary.asOf).toLocaleDateString()}.
          </p>
        </div>
        {loading && <span className="text-[11px] text-muted-foreground">Refreshing…</span>}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <MetricCard
          title="Accepted pages"
          value={String(summary.growth.acceptedPages)}
          detail={`${summary.growth.sources} sources · ${summary.growth.revisions} revisions`}
          icon={<BookOpen size={16} />}
          onClick={() => onNavigate({ view: "wiki" })}
        />
        <MetricCard
          title="Citation coverage"
          value={percent(summary.citationCoverage.ratio)}
          detail={`${summary.citationCoverage.citedPages} of ${summary.citationCoverage.totalPages} pages cited`}
          icon={<Quote size={16} />}
          onClick={() => onNavigate({ view: "wiki" })}
        />
        <MetricCard
          title="Freshness"
          value={String(summary.freshness.fresh)}
          detail={`${summary.freshness.aging} aging · ${summary.freshness.stale} stale`}
          icon={<Activity size={16} />}
          onClick={() => onNavigate({ view: "map", filter: "stale" })}
        />
        <MetricCard
          title="Health findings"
          value={String(findings)}
          detail={`${summary.health.orphanPages} orphan · ${summary.health.brokenLinks} broken · ${summary.health.contradictions} contradictory`}
          icon={<AlertTriangle size={16} />}
          onClick={() => onNavigate({ view: "map", filter: "unhealthy" })}
        />
        <MetricCard
          title="Connectivity"
          value={summary.connectivity.averageDegree.toFixed(1)}
          detail={`${summary.connectivity.connectedPages} connected pages · ${summary.connectivity.directedLinks} explicit links`}
          icon={<GitFork size={16} />}
          onClick={() => onNavigate({ view: "map", filter: "hubs" })}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-4" aria-labelledby="memory-growth-title">
          <div className="flex items-center justify-between">
            <h2 id="memory-growth-title" className="m-0 text-[12px] font-semibold text-text-bright">Weekly growth</h2>
            <button type="button" onClick={() => onNavigate({ view: "analytics" })} className="text-[11px] text-blue outline-none focus-visible:ring-2 focus-visible:ring-ring">
              View analytics
            </button>
          </div>
          <div className="mt-4 flex h-24 items-end gap-2" aria-hidden="true">
            {latestGrowth.map((day) => (
              <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-blue/70" style={{ height: `${Math.max(4, ((day.pages + day.revisions) / maxGrowth) * 72)}px` }} />
                <span className="font-mono text-[9px] text-dim">{day.day.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="sr-only">
            {latestGrowth.map((day) => `${day.day}: ${day.pages} pages and ${day.revisions} revisions`).join("; ")}
          </p>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4" aria-labelledby="memory-retrieval-title">
          <h2 id="memory-retrieval-title" className="m-0 text-[12px] font-semibold text-text-bright">Private retrieval activity</h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-[11.5px]">
            <div><dt className="text-muted-foreground">Searches</dt><dd className="m-0 mt-1 text-lg font-semibold tabular-nums text-text-bright">{summary.retrieval.searches}</dd></div>
            <div><dt className="text-muted-foreground">Results returned</dt><dd className="m-0 mt-1 text-lg font-semibold tabular-nums text-text-bright">{summary.retrieval.resultsReturned}</dd></div>
            <div><dt className="text-muted-foreground">Zero-result rate</dt><dd className="m-0 mt-1 font-mono text-text">{percent(summary.retrieval.zeroResultRatio)}</dd></div>
            <div><dt className="text-muted-foreground">Unique query hashes</dt><dd className="m-0 mt-1 font-mono text-text">{summary.retrieval.uniqueQueryHashes}</dd></div>
          </dl>
          <p className="m-0 mt-4 text-[10.5px] leading-4 text-dim">Only aggregate counts and one-way query hashes are retained; query text is not shown here.</p>
        </section>
      </div>
    </section>
  )
}
