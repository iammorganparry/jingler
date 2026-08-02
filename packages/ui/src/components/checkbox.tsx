import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * shadcn Checkbox at its default size (`size-4`), restyled to Jingler tokens.
 *
 * Built on a `<button>` rather than `@radix-ui/react-checkbox` — the package
 * doesn't carry that dependency and a controlled toggle needs nothing more — but
 * it keeps the radix-shaped `checked` / `onCheckedChange` API so callers read the
 * same either way.
 *
 * `tone="success"` gives the green "viewed" tick used in the Code Review rail;
 * the default `accent` fills with the brand like a normal shadcn checkbox.
 */
export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> & {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    tone?: "accent" | "success"
  }
>(({ className, checked = false, onCheckedChange, tone = "accent", onClick, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="checkbox"
    aria-checked={checked}
    data-state={checked ? "checked" : "unchecked"}
    onClick={(event) => {
      onCheckedChange?.(!checked)
      onClick?.(event)
    }}
    className={cn(
      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line bg-sunken text-transparent outline-none transition-[background-color,border-color,color,scale] duration-150 ease-out hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.9] disabled:cursor-not-allowed disabled:opacity-50",
      checked &&
        (tone === "success"
          ? "border-green/60 bg-green/15 text-green hover:border-green/60"
          : "border-brand bg-brand text-white hover:border-brand"),
      className
    )}
    {...props}
  >
    <Check size={11} strokeWidth={3} aria-hidden className={cn(!checked && "opacity-0")} />
  </button>
))
Checkbox.displayName = "Checkbox"
