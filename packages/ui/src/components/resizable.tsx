import * as React from "react"
import { cn } from "../lib/cn.js"

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

const readStored = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * A persisted, drag-resizable width. `adjust(dx)` nudges the width by a pixel
 * delta (from a drag handle), clamped to `[min, max]` and mirrored to
 * localStorage so the size survives reloads. Callers may provide a smaller
 * effective maximum when the surrounding layout needs to preserve space for
 * another pane.
 *
 * With `applyLive`, a drag stops going through React at all: each delta is
 * painted by the callback (a direct DOM style write) and the state + storage
 * commit ONCE via `commit()`, wired to the handle's drag-end. A setState per
 * pointermove re-rendered the whole subtree the size governs, sixty times a
 * second — which over a heavy pane (a sidebar of sessions, a terminal dock)
 * is measurable, and over a mounted diff was a memory spike. Without
 * `applyLive` the old per-move state behavior is preserved.
 */
export function useResizableWidth({
  storageKey,
  initial,
  min,
  max,
  applyLive
}: {
  storageKey: string
  initial: number
  min: number
  max: number
  /** Paint an in-drag value directly (e.g. `el.style.width = px`). */
  applyLive?: (value: number) => void
}) {
  const [width, setWidth] = React.useState(() => clamp(readStored(storageKey) ?? initial, min, max))
  const ref = React.useRef(width)
  ref.current = width
  const dragValue = React.useRef<number | null>(null)
  const applyLiveRef = React.useRef(applyLive)
  applyLiveRef.current = applyLive

  const persist = React.useCallback(
    (next: number) => {
      try {
        localStorage.setItem(storageKey, String(next))
      } catch {
        /* ignore quota / privacy-mode failures */
      }
    },
    [storageKey]
  )

  const adjust = React.useCallback(
    (dx: number, effectiveMax: number = max) => {
      const base = dragValue.current ?? ref.current
      const next = clamp(base + dx, min, Math.max(min, Math.min(max, effectiveMax)))
      const live = applyLiveRef.current
      if (live) {
        dragValue.current = next
        live(next)
        return
      }
      ref.current = next
      setWidth(next)
      persist(next)
    },
    [persist, min, max]
  )

  /** Land the drag's final value in state + storage. No-op outside a drag. */
  const commit = React.useCallback(() => {
    const next = dragValue.current
    dragValue.current = null
    if (next === null) return
    ref.current = next
    setWidth(next)
    persist(next)
  }, [persist])

  return { width, adjust, commit }
}

/**
 * A thin vertical drag handle between two columns. Reports per-move pixel deltas
 * via `onResize`; the visible hairline widens to blue on hover/drag and the hit
 * area extends a few px each side for an easy grab.
 */
export function ResizeHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
  className,
  "aria-label": ariaLabel = "Resize panel"
}: {
  onResize: (deltaX: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
  className?: string
  "aria-label"?: string
}) {
  const last = React.useRef(0)
  const dragging = React.useRef(false)
  const [active, setActive] = React.useState(false)
  const resizeCallback = React.useRef(onResize)
  const resizeEndCallback = React.useRef(onResizeEnd)
  resizeCallback.current = onResize
  resizeEndCallback.current = onResizeEnd

  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      resizeCallback.current(e.clientX - last.current)
      last.current = e.clientX
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      resizeEndCallback.current?.()
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }
    }
  }, [])

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        onResizeStart?.()
        dragging.current = true
        last.current = e.clientX
        setActive(true)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }}
      className={cn(
        "group relative z-10 w-px flex-none cursor-col-resize self-stretch bg-hairline",
        className
      )}
    >
      {/* Wide invisible hit area for an easy grab. */}
      <span className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      {/* The visible hairline, highlighted while hovered / dragging. */}
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-px transition-colors group-hover:bg-blue",
          active && "bg-blue"
        )}
      />
    </div>
  )
}
