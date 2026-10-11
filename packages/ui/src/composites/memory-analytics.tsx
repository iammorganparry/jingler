import type { MemoryDashboardSummary } from "@jingler/contracts";

export function MemoryAnalytics({
  summary,
}: {
  summary: MemoryDashboardSummary | null;
}) {
  if (summary === null)
    return (
      <p className="m-auto text-[12px] text-muted-foreground">
        Analytics are unavailable.
      </p>
    );
  const rows = [
    ["Accepted pages", summary.growth.acceptedPages],
    ["Sources", summary.growth.sources],
    [
      "Citation coverage",
      `${Math.round(summary.citationCoverage.ratio * 100)}%`,
    ],
    ["Fresh pages", summary.freshness.fresh],
    ["Stale pages", summary.freshness.stale],
    ["Open reviews", summary.reviewThroughput.open],
    ["Conflicts", summary.reviewThroughput.conflicted],
    ["Average degree", summary.connectivity.averageDegree],
    ["Searches", summary.retrieval.searches],
    ["Zero-result searches", summary.retrieval.zeroResultSearches],
    [
      "Weekly proposal recall",
      `${Math.round(summary.quality.totals.proposalRecall * 100)}%`,
    ],
    [
      "Weekly accept as-is",
      `${Math.round(summary.quality.totals.acceptAsIsRatio * 100)}%`,
    ],
    [
      "Terminal settlement",
      `${Math.round(summary.quality.totals.terminalSettlementRatio * 100)}%`,
    ],
    ["Sensitive escapes", summary.quality.totals.sensitiveEscapes],
    ["Stopped rollout arms", summary.rollout.stoppedArms.length],
  ];
  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-5"
      aria-labelledby="memory-analytics-title"
    >
      <h1
        id="memory-analytics-title"
        className="m-0 text-xl font-semibold text-text-bright"
      >
        Memory analytics
      </h1>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Text equivalents accompany every summary so trends remain readable
        without colour or motion.
      </p>
      <table className="mt-5 w-full overflow-hidden rounded-xl border border-line bg-panel text-left text-[12px]">
        <caption className="sr-only">Organization memory metrics</caption>
        <tbody>
          {rows.map(([label, value]) => (
            <tr
              key={String(label)}
              className="border-b border-hairline last:border-b-0"
            >
              <th
                scope="row"
                className="px-4 py-3 font-medium text-muted-foreground"
              >
                {label}
              </th>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-text-bright">
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="mt-5" aria-labelledby="memory-quality-segments-title">
        <h2
          id="memory-quality-segments-title"
          className="m-0 text-[12px] font-semibold text-text-bright"
        >
          Weekly rollout quality by cohort
        </h2>
        {summary.quality.segments.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            No labeled rollout samples this week.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full min-w-[720px] text-left text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Harness</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Arm</th>
                  <th className="px-3 py-2 font-medium">Length</th>
                  <th className="px-3 py-2 font-medium">Reviewed</th>
                  <th className="px-3 py-2 font-medium">Accept as-is</th>
                  <th className="px-3 py-2 font-medium">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {summary.quality.segments.map((segment) => (
                  <tr
                    key={`${segment.harness}:${segment.sourceKind}:${segment.experimentArm}:${segment.sessionLengthCohort}`}
                    className="border-t border-hairline text-text"
                  >
                    <td className="px-3 py-2 capitalize">{segment.harness}</td>
                    <td className="px-3 py-2 capitalize">
                      {segment.sourceKind}
                    </td>
                    <td className="px-3 py-2">
                      {segment.experimentArm.replaceAll("_", " ")}
                    </td>
                    <td className="px-3 py-2 capitalize">
                      {segment.sessionLengthCohort}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {segment.reviewedCandidates}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {Math.round(segment.acceptAsIsRatio * 100)}%
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {Math.round(segment.terminalSettlementRatio * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
