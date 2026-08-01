import type { MemoryDashboardSummary } from "@jingler/contracts"

export function MemoryAnalytics({ summary }: { summary: MemoryDashboardSummary | null }) {
  if (summary === null) return <p className="m-auto text-[12px] text-muted-foreground">Analytics are unavailable.</p>
  const rows = [
    ["Accepted pages", summary.growth.acceptedPages],
    ["Sources", summary.growth.sources],
    ["Citation coverage", `${Math.round(summary.citationCoverage.ratio * 100)}%`],
    ["Fresh pages", summary.freshness.fresh],
    ["Stale pages", summary.freshness.stale],
    ["Open reviews", summary.reviewThroughput.open],
    ["Conflicts", summary.reviewThroughput.conflicted],
    ["Average degree", summary.connectivity.averageDegree],
    ["Searches", summary.retrieval.searches],
    ["Zero-result searches", summary.retrieval.zeroResultSearches]
  ]
  return (
    <section className="min-h-0 flex-1 overflow-auto p-5" aria-labelledby="memory-analytics-title">
      <h1 id="memory-analytics-title" className="m-0 text-xl font-semibold text-text-bright">Memory analytics</h1>
      <p className="mt-1 text-[12px] text-muted-foreground">Text equivalents accompany every summary so trends remain readable without colour or motion.</p>
      <table className="mt-5 w-full overflow-hidden rounded-xl border border-line bg-panel text-left text-[12px]">
        <caption className="sr-only">Organization memory metrics</caption>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={String(label)} className="border-b border-hairline last:border-b-0">
              <th scope="row" className="px-4 py-3 font-medium text-muted-foreground">{label}</th>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-text-bright">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
