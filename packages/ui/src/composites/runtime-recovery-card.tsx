import { Search } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "../components/badge.js"
import { BannerShell } from "../components/banner-shell.js"
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
  /** Red icon only when failed; neutral otherwise. */
  readonly failed?: boolean
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
  failed = false,
  actionLabel,
  actionDisabled = false,
  onAction,
  inspectLabel = "Inspect changes",
  onInspect,
  onDismiss
}: RuntimeRecoveryCardProps) {
  const actionButton = (
    <Button key="action" variant="secondary" size="sm" disabled={actionDisabled} onClick={onAction}>
      {actionLabel}
    </Button>
  )

  const actions: readonly [ReactNode] | readonly [ReactNode, ReactNode] = onInspect
    ? [
        <Button key="inspect" variant="ghost" size="sm" onClick={onInspect}>
          <Search size={12} /> {inspectLabel}
        </Button>,
        actionButton
      ]
    : [actionButton]

  return (
    <section aria-label={label} className="flex-none">
      <BannerShell
        placement="lane"
        icon={icon}
        failed={failed}
        actions={actions}
        onDismiss={onDismiss}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {kind && (
              <Badge tone="neutral" size="xs">
                {kind}
              </Badge>
            )}
            <span className="truncate text-[11.5px] font-semibold">{title}</span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{message}</p>
          {detail && <p className="mt-0.5 font-mono text-[10px] text-dim">{detail}</p>}
        </div>
      </BannerShell>
    </section>
  )
}
