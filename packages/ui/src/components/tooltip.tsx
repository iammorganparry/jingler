import { isValidElement, type ReactElement, type ReactNode } from "react"
import { Tooltip as BeUITooltip } from "./beui/tooltip.js"

/** Compatibility API backed by the official BeUI Tooltip. */
export function Tooltip({
  label,
  side = "top",
  children,
  className
}: {
  label: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  children: ReactNode
  className?: string
}) {
  const trigger = isValidElement(children) ? children as ReactElement : <span>{children}</span>
  return <BeUITooltip content={label} side={side} className={className}>{trigger}</BeUITooltip>
}
