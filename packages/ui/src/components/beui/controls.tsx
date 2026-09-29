import { type ReactNode, useId } from "react"
import { MotionConfig, m, useReducedMotion, type Transition } from "motion/react"
import { cn } from "../../lib/cn.js"

export interface MotionTabItem<T extends string> { value: T; label: ReactNode; disabled?: boolean }
const TAB_TRANSITION: Transition = { type: "spring", stiffness: 170, damping: 24, mass: 1.2 }

/** Product compatibility API for the used BeUI Tabs primitive. */
export function MotionTabs<T extends string>({ items, value, onChange, variant = "pill", className }: {
  items: ReadonlyArray<MotionTabItem<T>>
  value: T
  onChange?: (value: T) => void
  variant?: "pill" | "underline" | "segment"
  className?: string
}) {
  const id = useId()
  const reduce = useReducedMotion()
  const listClass = variant === "pill"
    ? "inline-flex items-center gap-1 rounded-full bg-panel p-1"
    : variant === "underline"
      ? "inline-flex items-center gap-1 border-b border-line"
      : "flex w-full min-w-0 items-center gap-0 rounded-lg bg-panel p-0.5"
  const segmentRootClass = variant === "segment" ? "min-w-0" : undefined
  const segmentItemClass = variant === "segment" ? "min-w-0 flex-1" : undefined
  const segmentButtonClass = variant === "segment" ? "w-full min-w-0 overflow-hidden text-ellipsis" : undefined

  return <MotionConfig transition={reduce ? { duration: 0 } : TAB_TRANSITION}>
    <m.div layoutRoot className={cn(segmentRootClass, className)}>
      <div role="tablist" className={listClass}>
        {items.map((item) => {
          const active = item.value === value
          if (variant === "underline") return <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => !item.disabled && onChange?.(item.value)}
            className={cn(
              "relative isolate -mb-px inline-flex min-h-11 items-center px-3 pb-2.5 pt-1 text-sm font-medium transition-colors",
              active ? "text-text-bright" : "text-muted-foreground hover:text-text-bright",
              item.disabled && "cursor-not-allowed opacity-50"
            )}
          >
            {item.label}
            {active && <m.span layoutId={id} layout="position" className="absolute -bottom-px left-0 right-0 h-px bg-brand" />}
          </button>

          const radius = variant === "pill" ? "rounded-full" : "rounded-md"
          return <div key={item.value} className={cn("relative", segmentItemClass)}>
            {active && <m.span layoutId={id} layout="position" style={{ borderRadius: variant === "pill" ? 9999 : 8 }} className={cn("absolute inset-0 bg-brand", radius)} />}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              onClick={() => !item.disabled && onChange?.(item.value)}
              className={cn(
                "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none transition-colors",
                segmentButtonClass,
                active ? "text-white" : "text-muted-foreground hover:text-text-bright",
                item.disabled && "cursor-not-allowed opacity-50",
                radius
              )}
            >{item.label}</button>
          </div>
        })}
      </div>
    </m.div>
  </MotionConfig>
}
