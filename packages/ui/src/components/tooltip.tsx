import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { motion } from "motion/react"
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * The shadcn-shaped tooltip on Radix, animated with motion.
 *
 * Deliberately quick: a 150ms open delay and a 120ms ease-out pop keep it
 * feeling like a label surfacing, not a panel opening. Close is instant —
 * Radix unmounts the content and an exit animation on a tooltip only makes
 * the pointer feel slower than it is.
 */
export function Tooltip({
  label,
  side = "top",
  sideOffset = 6,
  children,
  className
}: {
  /** The tooltip text (or a small node — keep it a label, not a panel). */
  label: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  children: ReactNode
  className?: string
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={150} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content asChild side={side} sideOffset={sideOffset}>
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className={cn(
                "z-50 select-none rounded-md border border-line bg-sunken px-3 py-1.5",
                "text-[12.5px] leading-snug text-text-bright shadow-lg",
                className
              )}
            >
              {label}
              <TooltipPrimitive.Arrow
                className="fill-sunken"
                width={12}
                height={6}
              />
            </motion.div>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
