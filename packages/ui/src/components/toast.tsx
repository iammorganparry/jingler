import type { KeyboardEvent } from "react"
import { Check, Info, Bell, X, AlertCircle } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import type { ToastItem, ToastVariant } from "./toast-machine.js"

const icon: Record<ToastVariant, typeof Check> = {
  success: Check,
  error: AlertCircle,
  "needs-you": Bell,
  info: Info
}

export interface ToastProps {
  variant: ToastVariant
  title: string
  description?: string
  action?: { label: string; onAction: () => void }
  onDismiss: () => void
  className?: string
}

/** One notification. Neutral surface; only the error variant is red, and there is no success fill. */
export function Toast({ variant, title, description, action, onDismiss, className }: ToastProps) {
  const Icon = icon[variant]
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "error" ? "assertive" : "polite"}
      className={cn(
        "flex w-[340px] items-start gap-2.5 rounded-[8px] border border-line-strong bg-panel p-3 text-text-bright shadow-[0_8px_24px_var(--sb-shadow)]",
        variant === "error" && "border-state-failed/40",
        className
      )}
    >
      <Icon
        size={15}
        aria-hidden
        className={cn("mt-0.5 flex-none", variant === "error" ? "text-state-failed" : "text-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{title}</div>
        {description && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{description}</div>}
        {action && (
          <Button variant="secondary" size="sm" className="mt-2 h-7" onClick={action.onAction}>
            {action.label}
          </Button>
        )}
      </div>
      <Button variant="ghost" size="icon" className="-m-1 size-6" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={13} />
      </Button>
    </div>
  )
}

export interface ToastRegionProps {
  toasts: ReadonlyArray<ToastItem>
  onDismiss: (key: string) => void
  onPause: () => void
  onResume: () => void
  className?: string
}

/** Bottom-right stack, mounted once in the app shell. Hover or focus pauses the timers; Esc dismisses the newest. */
export function ToastRegion({ toasts, onDismiss, onPause, onResume, className }: ToastRegionProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    const newest = toasts.at(-1)
    if (event.key === "Escape" && newest) onDismiss(newest.key)
  }
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className={cn("fixed bottom-4 right-4 z-50 flex flex-col gap-2", className)}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      onKeyDown={onKeyDown}
    >
      {toasts.map(({ key, remainingMs: _remainingMs, sessionId: _sessionId, ...toast }) => (
        <Toast key={key} {...toast} onDismiss={() => onDismiss(key)} />
      ))}
    </section>
  )
}
