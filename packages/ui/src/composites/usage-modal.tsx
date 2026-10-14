import { Spin } from "../components/spin.js"
import type { ProviderUsage, Usage, UsageReport, UsageStatus, UsageWindow } from "@jingler/core"
import { Gauge, RefreshCw } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog.js"
import { KpiTile, StackedMiniBar } from "../components/kpi-tile.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { providerAuthRouteLabel } from "../lib/provider-connection-labels.js"

const fmtReset = (iso: string | null): string => {
  if (!iso) return "—"
  const d = new Date(iso)
  const day = d.toLocaleDateString(undefined, { weekday: "short" })
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return `Resets ${day} ${time}`
}

const fmtUsed = (u: number | null): string => (u == null ? "—" : `${Math.round(u)}% used`)

const fmtUpdated = (iso: string | null): string => {
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
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: barColor(w.status) }}
        />
      </div>
      <span className="w-[66px] flex-none text-right font-mono text-[11px] text-text-body">
        {fmtUsed(w.utilization)}
      </span>
    </div>
  )
}

function ProviderSection({ provider: p }: { provider: ProviderUsage }) {
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
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          <span>{route}</span>
          <span>Billing: {p.billingRoute ?? "unconfirmed"}</span>
          <span>Target: {p.targetId}</span>
          <span>Status: {p.authStatus}</span>
        </div>
      )}
      {(p.quotaLabel || p.rateLimitLabel) && (
        <div className="mb-2 text-[11px] text-text-body">
          {[p.quotaLabel, p.rateLimitLabel].filter(Boolean).join(" · ")}
        </div>
      )}
      {p.available ? (
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
    <div className="mb-3 grid grid-cols-4 gap-2" data-testid="usage-kpis">
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
  )
}

function ReportSection({ report, onExport }: { report: UsageReport; onExport?: () => Promise<void> | void }) {
  return (
    <div className="border-t border-hairline py-[14px]">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-semibold text-text-bright">Execution report</div>
        {onExport && <Button size="sm" variant="ghost" onClick={() => void onExport()}>Export JSON</Button>}
      </div>
      {report.groups.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">No completed parent or child runs recorded.</div>
      ) : <KpiStrip groups={report.groups} />}
      {report.groups.map((group) => (
        <div key={`${group.runtimeId}:${group.providerId}:${group.modelId}:${group.kind}`} className="flex items-center justify-between py-1 text-[11px] text-muted-foreground">
          <span>{group.runtimeId} · {group.modelId} · {group.kind}</span>
          <span>{group.runCount} runs · {Math.round((group.successRate ?? 0) * 100)}% ok · {group.totalTokens} tokens · {group.toolCalls} tools · {group.costCoverage === 1 ? `$${group.knownCostUsd.toFixed(2)}` : "cost partial"}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The Usage & limits modal: per-provider session/weekly windows as status-tinted
 * bars. Provider connections report usage through their pinned authentication
 * route; connections without a usage endpoint show as unavailable.
 */
export function UsageModal({
  open,
  usage,
  report,
  loading = false,
  onExport,
  onClose
}: {
  open: boolean
  usage?: Usage | null
  report?: UsageReport | null
  /** A usage fetch is in flight (the live read takes a couple of seconds). */
  loading?: boolean
  onExport?: () => Promise<void> | void
  onClose?: () => void
}) {
  const providers = usage?.providers ?? []
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[600px]">
        <DialogHeader>
          <Gauge size={16} className="text-blue" />
          <DialogTitle>Usage &amp; limits</DialogTitle>
        </DialogHeader>
        <DialogBody className="py-0">
          {providers.length > 0 ? (
            providers.map((p) => (
              <ProviderSection key={p.connectionId ?? p.name} provider={p} />
            ))
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Spin><RefreshCw size={13} /></Spin>
              Reading plan usage…
            </div>
          ) : (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              No provider connections are configured on this machine.
            </div>
          )}
          {report && <ReportSection report={report} onExport={onExport} />}
        </DialogBody>
        <DialogFooter className="justify-start text-[11px] text-muted-foreground">
          <Spin active={loading}><RefreshCw size={12} /></Spin>
          {loading && providers.length > 0 ? "Refreshing…" : `Last updated: ${fmtUpdated(usage?.fetchedAt ?? null)}`}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
