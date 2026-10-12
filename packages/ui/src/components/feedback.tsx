import type { ReactNode } from "react"
import { Check, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import { Skeleton } from "./loading.js"

/** Three bouncing dots — the "agent is thinking" cue. */
function ThinkingDots() {
  return (
    <span className="flex flex-none gap-[3px]">
      {[0, 0.18, 0.36].map((delay) => (
        <span
          key={delay}
          className="size-[5px] animate-pulse-dot rounded-full bg-current"
          style={{ animationDelay: `${delay}s`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  )
}

/**
 * A compact inline status line with feedback states — a spinner while working, the
 * bouncing "thinking" dots for the agent, or a check / x that slides in on
 * settle. Use next to async / agent actions.
 */
export function InlineStatus({
  variant,
  children,
  className
}: {
  variant: "loading" | "thinking" | "success" | "error"
  children: ReactNode
  className?: string
}) {
  const tone =
    variant === "success"
      ? "text-green animate-slide-in"
      : variant === "error"
        ? "text-red animate-slide-in"
        : variant === "thinking"
          ? "text-yellow"
          : "text-muted-foreground"

  return (
    <span className={cn("inline-flex items-center gap-2 text-[12px]", tone, className)}>
      {variant === "loading" && (
        <span className="inline-block size-[13px] flex-none animate-spin-fast rounded-full border-2 border-current/30 border-t-current" />
      )}
      {variant === "thinking" && <ThinkingDots />}
      {variant === "success" && <Check size={14} className="flex-none" />}
      {variant === "error" && <X size={14} className="flex-none" />}
      {children}
    </span>
  )
}

/**
 * A thin progress bar. With `progress` (0–1) it fills determinately; without, it
 * runs an indeterminate sweep — the "agent working, unknown duration" cue.
 */
export function IndeterminateBar({
  progress,
  tone = "bg-blue",
  className
}: {
  progress?: number
  tone?: string
  className?: string
}) {
  const determinate = typeof progress === "number"
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-surface", className)}>
      {determinate ? (
        <span
          className={cn("block h-full rounded-full transition-[width] duration-300", tone)}
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      ) : (
        <span className={cn("block h-full w-1/3 animate-bar rounded-full", tone)} />
      )}
    </div>
  )
}

/** Loading rows sized like the real rows they stand in for, so nothing shifts on load. */
export function ListSkeleton({
  rows = 3,
  rowHeight = 32,
  gap = 4,
  className
}: {
  rows?: number
  rowHeight?: number
  gap?: number
  className?: string
}) {
  return (
    <div aria-busy="true" className={cn("flex flex-col", className)} style={{ gap }}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-auto" style={{ height: rowHeight }} />
      ))}
    </div>
  )
}

/** An empty list: what is missing, plus the next action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className
}: {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-8 text-center", className)}>
      {icon && <span className="text-dim">{icon}</span>}
      <span className="text-[13px] font-medium text-text-bright">{title}</span>
      {description && <span className="max-w-xs text-[12px] text-muted-foreground">{description}</span>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

/** A load failure: the message, and a Retry button whenever `onRetry` is given. */
export function InlineError({
  message,
  onRetry,
  retryLabel = "Retry",
  className
}: {
  message: ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}) {
  return (
    <div role="alert" className={cn("flex items-center gap-3 px-3 py-2 text-[12px]", className)}>
      <span className="min-w-0 flex-1 text-state-failed">{message}</span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
