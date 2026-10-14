import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** One usage metric: label (+ optional "partial" marker on the same line), value and delta. A missing value renders the labelled "No data" placeholder, never a made-up number. */
export function KpiTile({
  label,
  value,
  delta,
  partial = false,
  className
}: {
  label: string
  value: ReactNode
  delta?: ReactNode
  /** The value only covers some runs (e.g. cost where pricing is unknown). */
  partial?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-xl border border-line p-3", className)}>
      <div data-testid="kpi-label" className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {partial && <span className="shrink-0 rounded-sm border border-line px-1 text-[11px] leading-4 text-dim">partial</span>}
      </div>
      <div className="text-[20px] font-semibold leading-tight text-text-bright tabular-nums">
        {value == null ? <span className="text-[13px] font-normal text-dim">No data</span> : value}
      </div>
      {delta && <div className="text-[11px] text-muted-foreground tabular-nums">{delta}</div>}
    </div>
  )
}

/** A horizontal stacked bar from plain numbers, in inline SVG. Segments shade from bright to dim. */
export function StackedMiniBar({
  values,
  label,
  width = 120,
  height = 6,
  className
}: {
  values: ReadonlyArray<number>
  label: string
  width?: number
  height?: number
  className?: string
}) {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  let x = 0
  return (
    <svg role="img" aria-label={label} width={width} height={height} className={cn("block overflow-hidden rounded-full bg-surface", className)}>
      {total > 0 &&
        values.map((value, index) => {
          const w = (Math.max(0, value) / total) * width
          const rect = (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            <rect key={index} x={x} y={0} width={w} height={height} fill="var(--sb-text-bright)" fillOpacity={1 - index * (0.7 / Math.max(1, values.length - 1))} />
          )
          x += w
          return rect
        })}
    </svg>
  )
}
