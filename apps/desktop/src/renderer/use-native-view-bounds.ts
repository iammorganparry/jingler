/**
 * useNativeViewBounds — keeps a main-process native overlay (a `WebContentsView`:
 * the browser preview, or Chromium's PDF viewer) aligned with a placeholder div
 * in the renderer.
 *
 * The browser body and the PDF body park DIFFERENT native views over the same
 * kind of measured hole, and they used to carry a byte-identical copy of this
 * loop each. This owns the whole discipline in one place: the ref to measure, the
 * `getBoundingClientRect` read, the `isPaintableRect` degenerate-rect guard, the
 * "only push when the bounds actually change" key, and rAF cleanup.
 *
 * ## The view is OPENED from the loop, not on mount
 *
 * A native view must not be created until a paintable rect exists. Opening on
 * mount looks fine until the placeholder measures 0×0 on that first run — dock
 * mid-transition, a side switch, any layout race — because the overlay then never
 * opens and the tab shows "Loading…" forever. So the FIRST paintable rect the
 * loop sees fires `onFirstPaintableRect` (open the view there), and every change
 * after fires `onBoundsChanged`. Consumers stay idempotent: `active` toggling
 * off and back on re-fires `onFirstPaintableRect`, so their open path must no-op
 * when the view is already up.
 */
import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"
import { isPaintableRect } from "./browser-preview-bounds.js"

export interface NativeViewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface UseNativeViewBoundsOptions {
  /**
   * Whether the native view is wanted on screen (the tab is focused AND the dock
   * is open). While false the loop does not run, and it restarts — re-arming the
   * first-paintable-rect fire — when it flips back to true.
   */
  active: boolean
  /** Fired once per `active` session, the first frame a paintable rect exists. */
  onFirstPaintableRect: (rect: NativeViewRect) => void
  /** Fired whenever the measured bounds change while `active`. */
  onBoundsChanged: (rect: NativeViewRect) => void
}

export function useNativeViewBounds({
  active,
  onFirstPaintableRect,
  onBoundsChanged
}: UseNativeViewBoundsOptions): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  const readRect = useCallback((): NativeViewRect | null => {
    const el = ref.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, [])

  // Held in refs so a fresh inline callback each render doesn't tear down and
  // restart the rAF loop — only `active` should do that.
  const onFirst = useRef(onFirstPaintableRect)
  onFirst.current = onFirstPaintableRect
  const onChanged = useRef(onBoundsChanged)
  onChanged.current = onBoundsChanged

  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = ""
    let firstSeen = false
    const tick = () => {
      const r = readRect()
      // A degenerate rect is NOT a small view — it's a placeholder that is
      // hidden, unmounted, or mid-transition through a dock switch. Pushing one
      // parks a zero-size (or negative) overlay over the placeholder, and
      // Chromium reflows the page to that size on the way through. Skipping
      // holds the last good bounds until the layout settles, one frame later.
      //
      // A SMALL rect is a different thing entirely and must still be pushed —
      // see `isPaintableRect` for what happened when this guard couldn't tell
      // the two apart.
      if (r && isPaintableRect(r)) {
        if (!firstSeen) {
          firstSeen = true
          onFirst.current(r)
        }
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
        if (key !== last) {
          last = key
          onChanged.current(r)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, readRect])

  return ref
}
