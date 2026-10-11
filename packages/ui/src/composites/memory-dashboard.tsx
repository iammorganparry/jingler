import type { MemoryDashboardSummary } from "@jingler/contracts";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  GitFork,
  Quote,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";

export type MemorySubview =
  "dashboard" | "map" | "wiki" | "reviews" | "analytics";

export interface MemoryDeepLink {
  readonly view: MemorySubview;
  readonly filter?: string;
}

export interface MemoryDashboardProps {
  summary: MemoryDashboardSummary | null;
  loading?: boolean;
  error?: string | null;
  onNavigate: (target: MemoryDeepLink) => void;
  onRetry?: () => void;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function MetricCard({
  title,
  value,
  detail,
  icon,
  onClick,
}: {
  title: string;
  value: string;
  detail: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group min-h-32 rounded-xl border border-line bg-panel p-4 text-left outline-none transition-colors hover:border-line-strong hover:bg-surface/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mb-5 flex items-center justify-between text-muted-foreground">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">
          {title}
        </span>
        {icon}
      </span>
      <strong className="block text-2xl font-semibold tabular-nums text-text-bright">
        {value}
      </strong>
      <span className="mt-1.5 block text-[11.5px] leading-5 text-muted-foreground">
        {detail}
      </span>
    </button>
  );
}

export function MemoryDashboard({
  summary,
  loading = false,
  error = null,
  onNavigate,
  onRetry,
}: MemoryDashboardProps) {
  if (loading && summary === null) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground"
        role="status"
      >
        <RefreshCw className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
        Loading organization memory summary…
      </div>
    );
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
    );
  }

  if (summary === null) return null;
  const findings =
    summary.health.orphanPages +
    summary.health.brokenLinks +
    summary.health.contradictions;
  const latestGrowth = summary.growth.daily.slice(-7);
  const maxGrowth = Math.max(
    1,
    ...latestGrowth.map((day) => day.pages + day.revisions),
  );

  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-5"
      aria-labelledby="memory-dashboard-title"
    >
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue">
            Team knowledge
          </p>
          <h1
            id="memory-dashboard-title"
            className="m-0 mt-1 text-xl font-semibold text-text-bright"
          >
            Memory overview
          </h1>
          <p className="m-0 mt-1 text-[12px] text-muted-foreground">
            Accepted evidence and privacy-safe activity as of{" "}
            {new Date(summary.asOf).toLocaleDateString()}.
          </p>
        </div>
        {loading && (
          <span className="text-[11px] text-muted-foreground">Refreshing…</span>
        )}
      </div>

      {!summary.rollout.safeToExpand && (
        <section
          className="mb-3 rounded-xl border border-red/50 bg-panel p-4"
          aria-labelledby="memory-rollout-stopped-title"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-red"
              aria-hidden="true"
            />
            <div>
              <h2
                id="memory-rollout-stopped-title"
                className="m-0 text-[12px] font-semibold text-text-bright"
              >
                Memory rollout automatically stopped
              </h2>
              <p className="m-0 mt-1 text-[11px] leading-5 text-muted-foreground">
                {summary.rollout.stoppedArms.join(", ").replaceAll("_", " ")}{" "}
                remain disabled until every weekly guardrail recovers.
              </p>
            </div>
          </div>
        </section>
      )}

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
          detail={`${summary.connectivity.durablePageEdges} durable page edges · ${summary.connectivity.citationEdges} source citations`}
          icon={<GitFork size={16} />}
          onClick={() => onNavigate({ view: "map", filter: "hubs" })}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section
          className="rounded-xl border border-line bg-panel p-4"
          aria-labelledby="memory-growth-title"
        >
          <div className="flex items-center justify-between">
            <h2
              id="memory-growth-title"
              className="m-0 text-[12px] font-semibold text-text-bright"
            >
              Weekly growth
            </h2>
            <button
              type="button"
              onClick={() => onNavigate({ view: "analytics" })}
              className="text-[11px] text-blue outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View analytics
            </button>
          </div>
          <div className="mt-4 flex h-24 items-end gap-2" aria-hidden="true">
            {latestGrowth.map((day) => (
              <div
                key={day.day}
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
              >
                <div
                  className="w-full rounded-t bg-blue/70"
                  style={{
                    height: `${Math.max(4, ((day.pages + day.revisions) / maxGrowth) * 72)}px`,
                  }}
                />
                <span className="font-mono text-[9px] text-dim">
                  {day.day.slice(5)}
                </span>
              </div>
            ))}
          </div>
          <p className="sr-only">
            {latestGrowth
              .map(
                (day) =>
                  `${day.day}: ${day.pages} pages and ${day.revisions} revisions`,
              )
              .join("; ")}
          </p>
        </section>

        <section
          className="rounded-xl border border-line bg-panel p-4"
          aria-labelledby="memory-retrieval-title"
        >
          <h2
            id="memory-retrieval-title"
            className="m-0 text-[12px] font-semibold text-text-bright"
          >
            Private retrieval activity
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-[11.5px]">
            <div>
              <dt className="text-muted-foreground">Searches</dt>
              <dd className="m-0 mt-1 text-lg font-semibold tabular-nums text-text-bright">
                {summary.retrieval.searches}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Results returned</dt>
              <dd className="m-0 mt-1 text-lg font-semibold tabular-nums text-text-bright">
                {summary.retrieval.resultsReturned}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Zero-result rate</dt>
              <dd className="m-0 mt-1 font-mono text-text">
                {percent(summary.retrieval.zeroResultRatio)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Unique query hashes</dt>
              <dd className="m-0 mt-1 font-mono text-text">
                {summary.retrieval.uniqueQueryHashes}
              </dd>
            </div>
          </dl>
          <p className="m-0 mt-4 text-[10.5px] leading-4 text-dim">
            Only aggregate counts and one-way query hashes are retained; query
            text is not shown here.
          </p>
        </section>
      </div>

      <section
        className="mt-3 rounded-xl border border-line bg-panel p-4"
        aria-labelledby="memory-funnel-title"
      >
        <div className="flex items-center justify-between gap-3">
          <h2
            id="memory-funnel-title"
            className="m-0 text-[12px] font-semibold text-text-bright"
          >
            Source conversion
          </h2>
          <span className="text-[10.5px] text-dim">
            {summary.funnel.transitions} content-free transitions
          </span>
        </div>
        {summary.funnel.bySourceKind.length === 0 ? (
          <p className="m-0 mt-3 text-[11px] text-muted-foreground">
            No funnel transitions in this window.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[11px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Source kind</th>
                  <th className="px-2 py-2 font-medium">Captured</th>
                  <th className="px-2 py-2 font-medium">Delivered</th>
                  <th className="px-2 py-2 font-medium">Proposals</th>
                  <th className="px-2 py-2 font-medium">Published</th>
                  <th className="px-2 py-2 font-medium">No learning</th>
                  <th className="px-2 py-2 font-medium">Delivery failures</th>
                  <th className="py-2 pl-2 font-medium">Compiler failures</th>
                </tr>
              </thead>
              <tbody>
                {summary.funnel.bySourceKind.map((row) => (
                  <tr
                    key={row.sourceKind}
                    className="border-t border-line/70 text-text"
                  >
                    <th
                      scope="row"
                      className="py-2.5 pr-3 text-left font-medium capitalize text-text-bright"
                    >
                      {row.sourceKind}
                    </th>
                    <td className="px-2 py-2.5 tabular-nums">{row.captured}</td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {row.delivered}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {row.proposals}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {row.published}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {row.noDurableLearning}
                    </td>
                    <td className="px-2 py-2.5 tabular-nums">
                      {row.deliveryFailures}
                    </td>
                    <td className="py-2.5 pl-2 tabular-nums">
                      {row.permanentFailures}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="m-0 mt-3 text-[10.5px] leading-4 text-dim">
          Source citations support claims; durable page edges are explicit
          page-to-page links. They are reported separately.
        </p>
      </section>
    </section>
  );
}
