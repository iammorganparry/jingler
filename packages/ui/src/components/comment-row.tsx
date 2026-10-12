import type { ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import { Tooltip } from "./tooltip.js"

/**
 * A plain comment-style row shared by review findings and inline review comments: severity as a
 * muted text label, the message, an action slot and a Dismiss icon button. No fill at any severity.
 */
export function CommentRow({
  severity,
  location,
  children,
  action,
  onDismiss,
  className
}: {
  severity?: string
  location?: string
  children: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div data-testid="comment-row" className={cn("flex flex-col gap-1.5 border-b border-hairline px-3 py-2.5", className)}>
      {(severity || location || onDismiss) && (
        <div className="flex items-center gap-2 whitespace-nowrap text-[11px]">
          {severity && <span className="flex-none font-medium text-muted-foreground">{severity}</span>}
          {location && <span className="min-w-0 flex-1 truncate font-mono text-dim" title={location}>{location}</span>}
          {onDismiss && (
            <Tooltip label="Dismiss">
              <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss} className="ml-auto size-6 flex-none">
                <X size={12} />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      <div className="text-[12.5px] leading-[1.5] text-text-bright">{children}</div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}
