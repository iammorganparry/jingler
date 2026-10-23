import * as React from "react"
import { cn } from "../lib/cn.js"

/** Plain text field: h32, r8, hairline border, brand focus ring. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "h-8 w-full rounded-lg border border-line bg-transparent px-3 text-[13px] leading-5 text-text-bright caret-text-bright outline-none transition-colors duration-150 placeholder:text-dim hover:border-line-strong focus:border-ring focus:ring-2 focus:ring-ring/30 aria-[invalid=true]:border-state-failed disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
))
Input.displayName = "Input"
