import type { ReactNode } from "react"
import { MotionTabs } from "./beui/controls.js"

export interface SegmentItem<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

/** Compatibility API backed by BeUI's segment Tabs variant. */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size,
  fullWidth,
  "aria-label": ariaLabel,
  className
}: {
  items: ReadonlyArray<SegmentItem<T>>
  value: T
  onChange?: (value: T) => void
  /** md = 28px (default), sm = 24px. */
  size?: "sm" | "md"
  fullWidth?: boolean
  "aria-label"?: string
  className?: string
}) {
  return <MotionTabs items={items} value={value} onChange={onChange} variant="segment" size={size} fullWidth={fullWidth} ariaLabel={ariaLabel} className={className} />
}
