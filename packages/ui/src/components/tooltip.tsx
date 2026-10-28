import { isValidElement, type ReactElement, type ReactNode } from "react"
import { Tooltip as BeUITooltip } from "./beui/tooltip.js"
import { KbdChip } from "./kbd.js"

/** Compatibility API backed by the official BeUI Tooltip. */
export function Tooltip({
  label,
  shortcut,
  side = "top",
  children,
  className,
  wrapperClassName
}: {
  label: ReactNode
  /** Shown after the label as a platform-aware KbdChip, e.g. `mod+k`. */
  shortcut?: string
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  children: ReactNode
  className?: string
  /** Classes for the anchor span, e.g. `w-full` to fill the parent. */
  wrapperClassName?: string
}) {
  const trigger = isValidElement(children) ? children as ReactElement : <span>{children}</span>
  const content = shortcut ? <span className="inline-flex items-center gap-2 whitespace-nowrap">{label}<KbdChip shortcut={shortcut} /></span> : label
  return <BeUITooltip content={content} side={side} className={className} wrapperClassName={wrapperClassName}>{trigger}</BeUITooltip>
}
