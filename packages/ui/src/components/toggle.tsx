import { useId, useState } from "react"
import { cn } from "../lib/cn.js"

export interface ToggleProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
  "aria-label"?: string
  /** `default` is 28x16 with a 12px thumb; `sm` is 24x14 with a 10px thumb. */
  size?: "sm" | "default"
  className?: string
  id?: string
}

const SIZES = {
  default: { track: "h-4 w-7", thumb: "size-3", on: "translate-x-3" },
  sm: { track: "h-3.5 w-6", thumb: "size-2.5", on: "translate-x-2.5" }
} as const

/** Compact switch. Public name stays `Toggle` so call sites compile; the track is calm (no squish/spring). */
export function Toggle({ checked, defaultChecked = false, onCheckedChange, disabled, label, ariaLabel, "aria-label": ariaLabelAttribute, size = "default", className, id: idProp }: ToggleProps) {
  const generatedId = useId()
  const id = idProp ?? generatedId
  const [internalChecked, setInternalChecked] = useState(defaultChecked)
  const currentChecked = checked ?? internalChecked
  const s = SIZES[size]
  const setChecked = (next: boolean) => {
    if (checked === undefined) setInternalChecked(next)
    onCheckedChange?.(next)
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={currentChecked}
        aria-label={ariaLabel ?? ariaLabelAttribute}
        disabled={disabled}
        onClick={() => !disabled && setChecked(!currentChecked)}
        data-state={currentChecked ? "checked" : "unchecked"}
        className={cn(
          "peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
          s.track,
          currentChecked ? "bg-primary-fill" : "bg-line-strong"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none block rounded-full shadow-sm transition-transform duration-150 motion-reduce:transition-none",
            s.thumb,
            currentChecked ? cn("bg-primary-fg", s.on) : "bg-panel translate-x-0"
          )}
        />
      </button>
      {label && <label htmlFor={id} className="cursor-pointer text-[13px] text-text-bright">{label}</label>}
    </span>
  )
}
