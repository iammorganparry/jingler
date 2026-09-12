import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * Spin — an HTML box that carries a looping keyframe animation for the icon
 * inside it.
 *
 * Put the animation class on the wrapper, never on the `<svg>`. Blink runs a
 * CSS transform animation on an SVG element on the MAIN thread: every frame
 * recomputes style for the target, throws away the geometry-mapper transform
 * cache for the whole document, and repaints — measured at 60 main-thread
 * frames a second and 70k transform-cache rebuilds a minute from one 12px
 * lucide spinner in an otherwise idle window. The same keyframes on an HTML
 * box are handed to the compositor and the main thread stays asleep.
 * `pnpm perf history` reports the running animations as `anim:` buckets;
 * `svg.spin` there means someone bypassed this wrapper.
 */
const KEYFRAMES = {
  spin: "animate-spin",
  "spin-fast": "animate-spin-fast",
  breathe: "animate-breathe",
  "pulse-dot": "animate-pulse-dot",
} as const

export interface SpinProps {
  /** Off = plain wrapper, no animation. Lets call sites keep one element tree. */
  active?: boolean
  animation?: keyof typeof KEYFRAMES
  /** Layout classes (`shrink-0`, `absolute …`) belong here, not on the icon. */
  className?: string
  children: ReactNode
}

export function Spin({ active = true, animation = "spin", className, children }: SpinProps) {
  return (
    <span className={cn("inline-flex", active && KEYFRAMES[animation], className)}>
      {children}
    </span>
  )
}
