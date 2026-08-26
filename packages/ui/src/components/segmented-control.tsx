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
  className
}: {
  items: ReadonlyArray<SegmentItem<T>>
  value: T
  onChange?: (value: T) => void
  className?: string
}) {
  return <MotionTabs items={items} value={value} onChange={onChange} variant="segment" className={className} />
}
