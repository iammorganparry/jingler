import type { ReactNode } from "react"
import { Check, Circle, X } from "lucide-react"
import { cn } from "../lib/cn.js"

/** One neutral status line: icon + muted text. Only `failed` introduces colour (spec §6.3). */
export function StatusRow({
  icon,
  failed = false,
  children,
  className
}: {
  icon?: ReactNode
  failed?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[12px]", failed ? "text-state-failed" : "text-muted-foreground", className)}>
      <span aria-hidden="true" className="flex size-[14px] flex-none items-center justify-center">
        {failed ? <X size={14} /> : (icon ?? <Circle size={6} className="fill-current" />)}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

/** Numbered steps: done ✓ / current ● / upcoming ○. The current step carries aria-current="step". */
export function Stepper({ steps, current, className }: { steps: ReadonlyArray<string>; current: number; className?: string }) {
  return (
    <ol aria-label="Progress" className={cn("flex items-center gap-3 text-[12px]", className)}>
      {steps.map((label, index) => {
        const state = index < current ? "done" : index === current ? "current" : "upcoming"
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            data-state={state}
            className={cn("flex items-center gap-1.5 whitespace-nowrap", state === "upcoming" ? "text-dim" : "text-text-bright")}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-[18px] flex-none items-center justify-center rounded-full border text-[11px] font-medium",
                state === "done" && "border-line-strong bg-surface",
                state === "current" && "border-text-bright",
                state === "upcoming" && "border-line"
              )}
            >
              {state === "done" ? <Check size={11} /> : index + 1}
            </span>
            <span>
              {label}
              {state === "done" && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
