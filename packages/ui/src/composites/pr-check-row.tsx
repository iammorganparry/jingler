import type { PrCheck } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"

/** Format a millisecond duration as a compact `1m 12s` / `48s` string. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** One CI check row: status glyph · name · duration or a details link. */
export function PrCheckRow({ check }: { check: PrCheck }) {
  const running = check.status === "running"
  return (
    <div className="flex h-9 items-center gap-2.5 border-b border-hairline px-3 last:border-b-0">
      <span className="flex w-3.5 flex-none items-center justify-center">
        {check.status === "pass" && <StatusDot tone="bg-green" size={7} glow={false} />}
        {check.status === "fail" && <StatusDot tone="bg-red" size={7} glow={false} />}
        {running && <StatusDot tone="bg-yellow" size={7} pulse />}
        {check.status === "pending" && <StatusDot tone="bg-line-strong" size={7} glow={false} />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", running ? "text-text-bright" : "text-text")}>
        {check.name}
      </span>
      {running ? (
        <span className="font-mono text-[11px] text-muted-foreground">running</span>
      ) : (
        check.durationMs !== null && (
          <span className="font-mono text-[11px] tabular-nums text-dim">{formatDuration(check.durationMs)}</span>
        )
      )}
      {check.detailsUrl && (
        <a
          href={check.detailsUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Details for ${check.name}`}
          className="text-[12px] text-muted-foreground hover:text-text-bright hover:underline"
        >
          Details
        </a>
      )}
    </div>
  )
}
