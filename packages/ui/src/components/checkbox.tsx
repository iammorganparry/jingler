import * as React from "react"
import { AnimatePresence, m, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { EASE_OUT, SPRING_PRESS } from "./beui/ease.js"
import { cn } from "../lib/cn.js"

const CHECK_PATH = "M5 13l4 4L19 7"
const INDETERMINATE_PATH = "M6 12h12"

export interface CheckboxProps
  extends Omit<HTMLMotionProps<"button">, "children" | "onChange" | "type"> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  indeterminate?: boolean
  label?: string
  tone?: "accent" | "success"
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, indeterminate = false, label, tone = "accent", onClick, disabled, id, ...props }, ref) => {
    const reduce = useReducedMotion()
    const showMark = checked || indeterminate
    const path = indeterminate ? INDETERMINATE_PATH : CHECK_PATH
    const control = (
      <m.button
        ref={ref}
        id={id}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        disabled={disabled}
        onClick={(event) => {
          if (!disabled) onCheckedChange?.(!checked)
          onClick?.(event)
        }}
        whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        data-state={checked ? "checked" : indeterminate ? "indeterminate" : "unchecked"}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md border-2 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-60",
          showMark
            ? tone === "success"
              ? "border-green bg-green text-white"
              : "border-brand bg-brand text-white"
            : "border-muted-foreground/50 bg-panel hover:border-muted-foreground",
          className
        )}
        {...props}
      >
        <AnimatePresence initial={false}>
          {showMark && (
            <m.svg
              key={indeterminate ? "indeterminate" : "checked"}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, filter: "blur(4px)" }}
              transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
              aria-hidden
            >
              <m.path
                d={path}
                initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={reduce ? { duration: 0 } : { duration: indeterminate ? 0.2 : 0.3, ease: EASE_OUT, delay: 0.04 }}
              />
            </m.svg>
          )}
        </AnimatePresence>
      </m.button>
    )

    return label ? (
      <label htmlFor={id} className={cn("inline-flex items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        {control}
        <span className={cn("select-none text-sm text-text-bright", disabled && "opacity-60")}>{label}</span>
      </label>
    ) : control
  }
)
Checkbox.displayName = "Checkbox"
