import { AlertTriangle, ArrowRight, Search, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../components/button.js"

export interface RuntimeRecoveryCardProps {
  /** Accessible name of the card's region; say what kind of recovery it is. */
  readonly label?: string
  /** Short category chip before the title (e.g. "MCP server"). */
  readonly kind?: string
  readonly title: string
  readonly message: string
  readonly icon?: ReactNode
  readonly detail?: string | null
  readonly actionLabel: string
  readonly actionDisabled?: boolean
  readonly onAction: () => void
  readonly inspectLabel?: string
  readonly onInspect?: () => void
  /** Hide the card. Omit for recoveries the operator must act on. */
  readonly onDismiss?: () => void
}

/** Actionable runtime recovery without exposing credentials or tool arguments. */
export function RuntimeRecoveryCard({
  label = "Runtime recovery",
  kind,
  title,
  message,
  icon,
  detail = null,
  actionLabel,
  actionDisabled = false,
  onAction,
  inspectLabel = "Inspect changes",
  onInspect,
  onDismiss
}: RuntimeRecoveryCardProps) {
  return (
    <section
      aria-label={label}
      className="flex flex-none items-start gap-3 border-b border-yellow/30 bg-yellow/5 px-3 py-2.5"
    >
      {icon ?? <AlertTriangle size={15} className="mt-0.5 flex-none text-yellow" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {kind && (
            <span className="flex-none rounded border border-yellow/30 bg-yellow/10 px-1.5 py-px font-mono text-[9.5px] font-medium uppercase tracking-wide text-yellow">
              {kind}
            </span>
          )}
          <span className="truncate text-[11.5px] font-semibold text-text-bright">{title}</span>
        </div>
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
        {onDismiss && (
          <Button variant="ghost" size="icon" aria-label={`Dismiss: ${title}`} onClick={onDismiss}>
            <X size={13} />
          </Button>
        )}
      </div>
    </section>
  )
}
