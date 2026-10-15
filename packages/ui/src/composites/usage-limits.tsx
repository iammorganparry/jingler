import { RELAY_USAGE_POLICY, type ProviderUsage, type Usage, type UsageWindow } from "@jingler/core"

/** "16:40" for a reset today, "Fri 16:40" otherwise. */
const fmtUntil = (iso: string): string => {
  const date = new Date(iso)
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
}

const windowDetail = (w: UsageWindow): string => {
  if (w.status === "limited") return w.resetsAt ? `Limited until ${fmtUntil(w.resetsAt)}` : "Limited"
  const used = w.utilization === null ? null : `${Math.round(w.utilization)}% used`
  const resets = w.resetsAt ? `resets ${fmtUntil(w.resetsAt)}` : null
  return [used, resets].filter(Boolean).join(" · ") || "No data"
}

function LimitRow({ window: w }: { window: UsageWindow }) {
  return (
    <div
      data-testid="usage-limit-row"
      data-limited={w.status === "limited"}
      className="flex items-baseline justify-between gap-3 py-0.5 text-[11.5px]"
    >
      <span className="min-w-0 truncate text-text-body">{w.label}</span>
      <span className="flex-none text-muted-foreground tabular-nums">{windowDetail(w)}</span>
    </div>
  )
}

const GIB = 1_024 ** 3

/**
 * Limits-only summary shown in the avatar popover: one neutral row per provider
 * limit window (reset time on a limited one, never a traffic-light fill) plus
 * the relay quota. Relay figures are placeholders until the relay reports usage.
 */
export function UsageLimits({ usage, loading = false }: { usage?: Usage | null; loading?: boolean }) {
  const providers: ReadonlyArray<ProviderUsage> = (usage?.providers ?? []).filter((p) => p.windows.length > 0)
  return (
    <div data-testid="usage-limits" className="flex flex-col gap-2 px-2.5 py-1.5">
      {providers.map((p) => (
        <div key={p.connectionId ?? p.name}>
          <div className="text-[11px] font-semibold text-text-bright">{p.name}</div>
          {p.windows.map((w) => <LimitRow key={w.label} window={w} />)}
        </div>
      ))}
      {providers.length === 0 && (
        <div className="text-[11.5px] text-muted-foreground">
          {loading ? "Reading plan usage…" : "No limits reported."}
        </div>
      )}
      <div data-testid="usage-relay-quota" className="flex items-baseline justify-between gap-3 text-[11.5px]">
        <span className="text-text-body">Relay quota</span>
        <span className="text-muted-foreground">
          {RELAY_USAGE_POLICY.defaultAccountQuotaBytes / GIB} GiB per account · usage not reported yet (placeholder)
        </span>
      </div>
    </div>
  )
}
