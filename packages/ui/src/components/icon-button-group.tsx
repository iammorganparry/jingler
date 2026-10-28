import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import { Tooltip } from "./tooltip.js"

export interface IconButtonGroupItem {
  readonly id: string
  /** Tooltip text and accessible name. */
  readonly label: string
  readonly icon: ReactNode
  readonly onClick?: () => void
  /** When defined the button is a toggle and exposes `aria-pressed`. */
  readonly pressed?: boolean
  readonly disabled?: boolean
}

/** One bordered unit of icon buttons (browser toolbar: back, forward, reload). Spec §6.9. */
export function IconButtonGroup({
  items,
  label,
  className
}: {
  readonly items: ReadonlyArray<IconButtonGroupItem>
  /** Accessible name of the whole group. */
  readonly label: string
  readonly className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Tab order stays plain; arrows additionally move focus between enabled buttons.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-slot="icon-button-group"
      onKeyDown={onKeyDown}
      className={cn("flex w-fit items-stretch divide-x divide-line overflow-hidden rounded-[6px] border border-line", className)}
    >
      {items.map((item) => (
        <Tooltip key={item.id} label={item.label}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={item.label}
            aria-pressed={item.pressed}
            disabled={item.disabled}
            onClick={item.onClick}
            className={cn(
              "size-7 rounded-none focus-visible:ring-inset focus-visible:ring-offset-0",
              item.pressed && "bg-text-bright/10 text-text-bright"
            )}
          >
            {item.icon}
          </Button>
        </Tooltip>
      ))}
    </div>
  )
}
