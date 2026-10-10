import { type KeyboardEvent, type ReactNode, useCallback, useId, useLayoutEffect, useRef } from "react"
import { MotionConfig, m, useReducedMotion, type Transition } from "motion/react"
import { cn } from "../../lib/cn.js"

export interface MotionTabItem<T extends string> { value: T; label: ReactNode; disabled?: boolean }
const TAB_TRANSITION: Transition = { type: "spring", stiffness: 170, damping: 24, mass: 1.2 }

const nextTabIndex = (key: string, current: number, count: number, rtl: boolean) => {
  if (key === "Home") return 0
  if (key === "End") return count - 1
  const step = (key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1)
  return (current + step + count) % count
}

/** Product compatibility API for the used BeUI Tabs primitive. */
export function MotionTabs<T extends string>({ items, value, onChange, variant = "pill", className }: {
  items: ReadonlyArray<MotionTabItem<T>>
  value: T
  onChange?: (value: T) => void
  variant?: "pill" | "underline" | "segment"
  className?: string
}) {
  const id = useId()
  const reduce = useReducedMotion()
  const viewportRef = useRef<HTMLDivElement>(null)
  const reveal = useCallback((tab: HTMLElement | null) => {
    const viewport = viewportRef.current
    if (!viewport || !tab) return
    const frame = viewport.getBoundingClientRect()
    const item = tab.getBoundingClientRect()
    const delta = item.left < frame.left ? item.left - frame.left : item.right > frame.right ? item.right - frame.right : 0
    if (delta) viewport.scrollBy({ left: delta, behavior: reduce ? "instant" : "smooth" })
  }, [reduce])
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => reveal(viewport.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    const list = viewport.querySelector('[role="tablist"]')
    if (list) observer.observe(list)
    return () => observer.disconnect()
  }, [value, reveal])

  const tabbableValue = items.find((item) => item.value === value && !item.disabled)?.value
    ?? items.find((item) => !item.disabled)?.value
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onChange || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const enabled = items.filter((item) => !item.disabled)
    if (enabled.length === 0 || !(event.target instanceof HTMLElement)) return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')]
    const button = event.target.closest<HTMLButtonElement>('[role="tab"]')
    if (!button) return
    const current = tabs.indexOf(button)
    if (current < 0) return
    const next = nextTabIndex(event.key, current, enabled.length, getComputedStyle(event.currentTarget).direction === "rtl")
    const nextTab = tabs[next]
    const nextItem = enabled[next]
    if (!nextTab || !nextItem) return
    event.preventDefault()
    nextTab.focus({ preventScroll: true })
    onChange(nextItem.value)
  }
  const renderUnderlineTab = (item: MotionTabItem<T>, active: boolean, tabIndex: number) => <button
    key={item.value} type="button" role="tab" tabIndex={tabIndex}
    aria-selected={active} disabled={item.disabled}
    onClick={() => onChange?.(item.value)}
    className={cn(
      "relative isolate -mb-px inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-3 pb-2.5 pt-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      active ? "text-text-bright" : "text-muted-foreground hover:text-text-bright",
      item.disabled && "cursor-not-allowed opacity-50"
    )}
  >
    {item.label}
    {active && <m.span layoutId={id} layout="position" className="absolute -bottom-px left-0 right-0 h-px bg-brand" />}
  </button>
  const listClass = variant === "pill"
    ? "inline-flex w-max items-center gap-1 rounded-full bg-panel p-1"
    : variant === "underline"
      ? "inline-flex w-max min-w-full items-center gap-1 border-b border-line"
      : "inline-flex w-max min-w-full items-center gap-0 rounded-lg bg-panel p-0.5"

  return <MotionConfig transition={reduce ? { duration: 0 } : TAB_TRANSITION}>
    <m.div layoutRoot className={cn("min-w-0 max-w-full", className)}>
      <m.div ref={viewportRef} layoutScroll className="max-w-full overflow-x-auto overflow-y-hidden"
        onFocusCapture={(event) => reveal(event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="tab"]') : null)}>
        <div role="tablist" className={listClass} onKeyDown={navigate}>
          {items.map((item) => {
            const active = item.value === value
            const tabIndex = item.value === tabbableValue ? 0 : -1
            if (variant === "underline") return renderUnderlineTab(item, active, tabIndex)
            const radius = variant === "pill" ? "rounded-full" : "rounded-md"
            return <div key={item.value} className="relative shrink-0">
              {active && <m.span layoutId={id} layout="position" style={{ borderRadius: variant === "pill" ? 9999 : 8 }} className={cn("absolute inset-0 bg-brand", radius)} />}
              <button
                type="button" role="tab" tabIndex={tabIndex}
                aria-selected={active} disabled={item.disabled}
                onClick={() => onChange?.(item.value)}
                className={cn(
                  "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active ? "text-primary-foreground" : "text-muted-foreground hover:text-text-bright",
                  item.disabled && "cursor-not-allowed opacity-50", radius
                )}
              >{item.label}</button>
            </div>
          })}
        </div>
      </m.div>
    </m.div>
  </MotionConfig>
}
