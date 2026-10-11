import type { ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import { Tooltip } from "./tooltip.js"

const placementClass = {
  top: "border-b border-hairline px-3 py-1.5",
  lane: "border-b border-line px-3 py-2",
  card: "rounded-xl border border-line px-3 py-2"
} as const

/**
 * Neutral notice: icon slot (red only when `failed`), one-line message that truncates, up to two
 * actions that never wrap, and an optional dismiss. Never a coloured fill (spec §6.3).
 */
export function BannerShell({
  icon,
  failed = false,
  children,
  actions,
  onDismiss,
  placement = "card",
  className
}: {
  icon?: ReactNode
  failed?: boolean
  children: ReactNode
  /** At most two; extra actions belong in an overflow menu. */
  actions?: readonly [ReactNode] | readonly [ReactNode, ReactNode]
  onDismiss?: () => void
  placement?: keyof typeof placementClass
  className?: string
}) {
  return (
    <div
      role={failed ? "alert" : "status"}
      data-testid="banner-shell"
      className={cn("flex min-w-0 items-center gap-2 text-[12px]", placementClass[placement], className)}
    >
      {icon && (
        <span aria-hidden="true" className={cn("flex flex-none items-center", failed ? "text-state-failed" : "text-muted-foreground")}>
          {icon}
        </span>
      )}
      <span data-testid="banner-message" className="min-w-0 flex-1 truncate text-text-bright">{children}</span>
      {actions && <div data-testid="banner-actions" className="flex flex-none items-center gap-1.5 whitespace-nowrap">{actions}</div>}
      {onDismiss && (
        <Tooltip label="Dismiss">
          <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss} className="size-6 flex-none">
            <X size={12} />
          </Button>
        </Tooltip>
      )}
    </div>
  )
}
