import * as React from "react"
import { cn } from "../lib/cn.js"

/** Multi-line sibling of `Input`: same border, focus ring and disabled states. */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-24 w-full resize-y rounded-xl border border-line bg-transparent px-3.5 py-2.5 text-base leading-6 text-text-bright caret-text-bright outline-none transition-colors duration-200 placeholder:text-muted-foreground/60 focus:border-text-bright/40 focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
      className
    )}
    {...props}
  />
))
Textarea.displayName = "Textarea"
