import type { ReactNode } from "react"
import { Check, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"

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

/**
 * Placeholder rows while a list loads. Rows use the real row height so nothing shifts when data
 * arrives; the shimmer rows are hidden from assistive tech and the container announces busy.
 */
export function ListSkeleton({
  rows = 3,
  rowHeight = 32,
  label = "Loading",
  className
}: {
  rows?: number
  rowHeight?: number
  label?: string
  className?: string
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn("flex flex-col gap-1", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={index}
          aria-hidden="true"
          data-testid="list-skeleton-row"
          className="block animate-pulse rounded-md bg-surface"
          style={{ height: rowHeight }}
        />
      ))}
    </div>
  )
}

/** "What's here + what to do next": a heading, optional detail and one optional action. */
export function EmptyState({
  title,
  description,
  action,
  className
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center", className)}>
      <h3 className="text-[13px] font-medium text-text-bright">{title}</h3>
      {description && <p className="max-w-[320px] text-[12px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

/** An error message with a Retry button whenever `onRetry` is given. Red is reserved for this. */
export function InlineError({
  children,
  onRetry,
  retryLabel = "Retry",
  className
}: {
  children: ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}) {
  return (
    <div role="alert" className={cn("flex items-center gap-2 text-[12px] text-state-failed", className)}>
      <X size={14} aria-hidden="true" className="flex-none" />
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
