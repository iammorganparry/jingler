import { animate, m, MotionConfig, useReducedMotion } from "motion/react"
import { useEffect, useId, useRef, useState } from "react"
import { cn } from "../lib/cn.js"

const THUMB_SPRING = { type: "spring", stiffness: 800, damping: 80, mass: 4 } as const

export interface ToggleProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
  "aria-label"?: string
  className?: string
  id?: string
}

export function Toggle({ checked, defaultChecked = false, onCheckedChange, disabled, label, ariaLabel, "aria-label": ariaLabelAttribute, className, id: idProp }: ToggleProps) {
  const generatedId = useId()
  const id = idProp ?? generatedId
  const thumbRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const [internalChecked, setInternalChecked] = useState(defaultChecked)
  const currentChecked = checked ?? internalChecked
  const [isPressed, setIsPressed] = useState(false)
  const [isPointer, setIsPointer] = useState(false)

  useEffect(() => {
    if (!thumbRef.current || reduce) return
    if (disabled && isPressed) animate(thumbRef.current, { x: [0, -2, 2, -1, 0] }, { delay: 0.2, duration: 0.6 })
  }, [disabled, isPressed, reduce])

  const squish = !disabled && isPointer && isPressed && !reduce
  const setChecked = (next: boolean) => {
    if (checked === undefined) setInternalChecked(next)
    onCheckedChange?.(next)
  }

  return (
    <MotionConfig transition={reduce ? { duration: 0 } : THUMB_SPRING}>
      <span className={cn("inline-flex items-center gap-3", className)}>
        <m.button
          id={id}
          type="button"
          role="switch"
          aria-checked={currentChecked}
          aria-label={ariaLabel ?? ariaLabelAttribute}
          disabled={disabled}
          onClick={() => !disabled && setChecked(!currentChecked)}
          onPointerDown={(event) => { setIsPressed(true); setIsPointer(event.type.startsWith("pointer")) }}
          onPointerUp={() => setIsPressed(false)}
          onPointerLeave={() => setIsPressed(false)}
          initial={false}
          data-state={currentChecked ? "checked" : "unchecked"}
          className={cn(
            "group peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full px-1 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-60",
            currentChecked ? "justify-end bg-brand" : "justify-start bg-muted-foreground/60"
          )}
        >
          <m.div ref={thumbRef} layout animate={{ scale: squish ? 0.9 : 1 }} className="pointer-events-none block size-5 rounded-full bg-panel shadow-md">
            <div className={cn("size-5", squish && (currentChecked ? "ml-1" : "mr-1"))} />
          </m.div>
        </m.button>
        {label && <label htmlFor={id} className="cursor-pointer text-sm text-text-bright">{label}</label>}
      </span>
    </MotionConfig>
  )
}
