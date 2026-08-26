import * as React from "react"
import { cn } from "../lib/cn.js"

/** Plain-field compatibility API using BeUI Input's field geometry and states. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "h-11 w-full rounded-full border border-line bg-transparent px-3.5 text-base leading-6 text-text-bright caret-text-bright outline-none transition-colors duration-200 placeholder:text-muted-foreground/60 focus:border-text-bright/40 focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
      className
    )}
    {...props}
  />
))
Input.displayName = "Input"
