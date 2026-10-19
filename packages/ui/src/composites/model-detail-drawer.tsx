import type { ModelDetail, ModelDetailPoint } from "@jingler/core"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "../components/drawer.js"

const fmtDuration = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const fmtPercent = (fraction: number | null): string => (fraction == null ? "—" : `${Math.round(fraction * 100)}%`)

/** A duration trend in run order, inline SVG polyline; flat zero-line when every point is zero. */
function Sparkline({ points, width = 432, height = 40 }: { points: ReadonlyArray<ModelDetailPoint>; width?: number; height?: number }) {
  const max = Math.max(1, ...points.map((p) => p.durationMs))
  const step = points.length > 1 ? width / (points.length - 1) : 0
  const coords = points.map((p, i) => `${i * step},${height - (p.durationMs / max) * height}`)
  return (
    <svg
      role="img"
      aria-label="Duration trend across runs, oldest to newest"
      width={width}
      height={height}
      className="block"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="var(--sb-blue)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** One stat tile: label over value, matching the KPI strip's visual weight at drawer scale. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-[13px] text-text-bright tabular-nums">{value}</div>
    </div>
  )
}

/**
 * Per-model drill-down (480px) opened from a `ModelPerformanceTable` row: aggregate stats,
 * a duration sparkline and the slowest runs for that model. Run→turn links are not yet
 * available (`UsageFact` has no turn id); the slowest-runs list shows run ids only.
 */
export function ModelDetailDrawer({
  open,
  detail,
  onOpenChange
}: {
  open: boolean
  detail: ModelDetail | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Drawer open={open && detail !== null} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="model-detail-drawer">
        {detail && (
          <div className="flex flex-1 flex-col overflow-y-auto p-4">
            <DrawerTitle className="text-[14px] font-semibold text-text-bright">{detail.group.modelId}</DrawerTitle>
            <DrawerDescription className="text-[11px] text-muted-foreground">
              {detail.group.runtimeId} · {detail.group.providerId ?? "unknown provider"} · {detail.group.kind}
            </DrawerDescription>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <Stat label="Runs" value={String(detail.group.runCount)} />
              <Stat label="Success rate" value={fmtPercent(detail.group.successRate)} />
              <Stat label="Total duration" value={fmtDuration(detail.group.durationMs)} />
              <Stat label="Tokens" value={detail.group.totalTokens.toLocaleString()} />
              <Stat
                label="Known cost"
                value={detail.group.costCoverage === 1 ? `$${detail.group.knownCostUsd.toFixed(2)}` : `$${detail.group.knownCostUsd.toFixed(2)} partial`}
              />
              <Stat label="Tool calls" value={detail.group.toolCalls.toLocaleString()} />
            </div>

            <div className="mt-5">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Duration trend</div>
              {detail.sparkline.length > 1 ? (
                <Sparkline points={detail.sparkline} />
              ) : (
                <div className="text-[11px] text-dim">Not enough runs for a trend.</div>
              )}
            </div>

            <div className="mt-5">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Slowest runs</div>
              <ul data-testid="model-detail-slowest-runs" className="flex flex-col gap-1">
                {detail.slowestRuns.map((run) => (
                  <li key={run.id} className="flex items-center justify-between border-t border-hairline py-1.5 text-[11.5px] first:border-0 first:pt-0">
                    <span className="truncate font-mono text-text-body" title={run.runId}>{run.runId}</span>
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{fmtDuration(run.durationMs)}</span>
                  </li>
                ))}
              </ul>
              {/* Run ids aren't yet linked to their chat turn (no turnId on UsageFact); follow-up: link runs to turns. */}
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
