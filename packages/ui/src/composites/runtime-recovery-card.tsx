import { AlertTriangle, ArrowRight, Search } from "lucide-react"
import { Button } from "../components/button.js"

export interface RuntimeRecoveryCardProps {
  readonly title: string
  readonly message: string
  readonly detail?: string | null
  readonly actionLabel: string
  readonly actionDisabled?: boolean
  readonly onAction: () => void
  readonly inspectLabel?: string
  readonly onInspect?: () => void
}

/** Actionable runtime recovery without exposing credentials or tool arguments. */
export function RuntimeRecoveryCard({
  title,
  message,
  detail = null,
  actionLabel,
  actionDisabled = false,
  onAction,
  inspectLabel = "Inspect changes",
  onInspect
}: RuntimeRecoveryCardProps) {
  return (
    <section
      aria-label="Runtime recovery"
      className="flex flex-none items-start gap-3 border-b border-yellow/30 bg-yellow/5 px-3 py-2.5"
    >
      <AlertTriangle size={15} className="mt-0.5 flex-none text-yellow" />
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] font-semibold text-text-bright">{title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{message}</p>
        {detail && <p className="mt-1 font-mono text-[10px] text-dim">{detail}</p>}
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {onInspect && (
          <Button variant="ghost" size="sm" onClick={onInspect}>
            <Search size={12} /> {inspectLabel}
          </Button>
        )}
        <Button variant="secondary" size="sm" disabled={actionDisabled} onClick={onAction}>
          {actionLabel} <ArrowRight size={12} />
        </Button>
      </div>
    </section>
  )
}
