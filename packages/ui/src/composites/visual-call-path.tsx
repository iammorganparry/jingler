import type { PlanCallPathDiff, PlanCallPathFrame } from "@jingler/core"
import { ArrowRight, GitCompareArrows } from "lucide-react"

const frameKey = (frame: PlanCallPathFrame, index: number): string =>
  `${index}:${frame.symbol}:${frame.path ?? ""}`

function CallFrame({ frame }: { readonly frame: PlanCallPathFrame }) {
  return (
    <span className="inline-flex min-w-0 flex-col rounded-md border border-line bg-surface/50 px-2 py-1.5">
      <span className="font-mono text-[11px] font-medium text-text-bright">{frame.symbol}</span>
      {frame.path && (
        <span className="max-w-48 truncate font-mono text-[9.5px] text-muted-foreground">{frame.path}</span>
      )}
    </span>
  )
}

function CallPath({ label, frames }: { readonly label: string; readonly frames: ReadonlyArray<PlanCallPathFrame> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {frames.map((frame, index) => (
          <div key={frameKey(frame, index)} className="contents">
            {index > 0 && <ArrowRight className="size-3 flex-none text-dim" />}
            <CallFrame frame={frame} />
          </div>
        ))}
        {frames.length === 0 && <span className="text-[11px] text-dim">No call path</span>}
      </div>
    </div>
  )
}

export function VisualCallPathDiff({ diff }: { readonly diff: PlanCallPathDiff }) {
  return (
    <section aria-label="Call path diff" className="flex flex-col gap-3 rounded-md border border-line bg-editor/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-bright">
        <GitCompareArrows className="size-3.5 text-blue" /> Call path change
      </div>
      <CallPath label="Before" frames={diff.before} />
      <CallPath label="After" frames={diff.after} />
    </section>
  )
}
