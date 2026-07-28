import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * A monospace keyboard chip. `onFill` sits ON a primary-coloured surface.
 *
 * `onFill` is a translucent white scrim, NOT another accent. It used to be
 * `bg-blue text-editor`, which was invisible while primary was also blue and
 * became a blue tile floating on a red button the moment primary moved to the
 * brand. A chip on a filled button is a shade of that button — anything else is
 * a second accent competing with the one the button already is.
 *
 * White-over-fill also means this needs no per-variant knowledge: it lands
 * correctly on brand, on danger, and on whatever a future variant fills with.
 */
export function Kbd({
  children,
  onFill = false,
  className
}: {
  children: ReactNode
  onFill?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-[10px] leading-none",
        onFill
          ? "bg-white/22 text-white"
          : "border border-line text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}
