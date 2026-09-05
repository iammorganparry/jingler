/**
 * useNativeViewBounds — keeps a main-process native overlay (a `WebContentsView`:
 * the browser preview, or Chromium's PDF viewer) aligned with a placeholder div
 * in the renderer.
 *
 * The browser body and the PDF body park DIFFERENT native views over the same
 * kind of measured hole, and they used to carry a byte-identical copy of this
 * loop each. This owns the whole discipline in one place: the ref to measure, the
 * `getBoundingClientRect` read, the `isPaintableRect` degenerate-rect guard, the
 * "only push when the bounds actually change" key, and teardown.
 *
 * ## The view is OPENED from the measurement, not on mount
 *
 * A native view must not be created until a paintable rect exists. Opening on
 * mount looks fine until the placeholder measures 0×0 on that first run — dock
 * mid-transition, a side switch, any layout race — because the overlay then never
 * opens and the tab shows "Loading…" forever. So the FIRST paintable rect seen
 * fires `onFirstPaintableRect` (open the view there), and every change after
 * fires `onBoundsChanged`. Consumers stay idempotent: `active` toggling off and
 * back on re-fires `onFirstPaintableRect`, so their open path must no-op when
 * the view is already up.
 *
 * ## Why this is NOT a requestAnimationFrame loop any more
 *
 * It was: one `getBoundingClientRect()` per frame for as long as the dock was
 * open. A rect read forces style + layout whenever the tree is dirty, and with
 * an agent streaming (or a spinner running) it is dirty every frame — so the
 * loop cost ~80ms of every second in layout alone, and every one of those
 * forced layouts churned Blink's layout and paint-property objects
 * (`LayoutResult`, `PaintChunk`, `PendingLayer`, `GeometryMapperTransformCache`)
 * into Oilpan garbage. That was the "in-app browser open in several sessions
 * → renderer at 13GB" report: the memory-infra dump showed 370k cache entries
 * and a 900MB Oilpan heap with 300MB live.
 *
 * Bounds only change for a reason, and every reason has a cheaper signal:
 * - the placeholder resized (dock drag, side switch, sidebar toggle, window
 *   resize): a `ResizeObserver` fires AFTER layout, so the read is free;
 * - a CSS transition/animation that moved it finished: `transitionend` /
 *   `animationend` (captured at the document, they bubble from anywhere);
 * - the placeholder was 0×0 on activation because the dock is mid-transition:
 *   a rAF settle loop that runs ONLY until the first paintable rect;
 * - anything else that shifts x/y without resizing: a slow poll, two reads a
 *   second, as the backstop.
 */
import { useEffect, useRef } from "react"
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
   * is open). While false nothing is observed, and observation restarts —
   * re-arming the first-paintable-rect fire — when it flips back to true.
   */
  active: boolean
  /** Fired once per `active` session, the first time a paintable rect exists. */
  onFirstPaintableRect: (rect: NativeViewRect) => void
  /** Fired whenever the measured bounds change while `active`. */
  onBoundsChanged: (rect: NativeViewRect) => void
}

/** Backstop cadence for position-only shifts no observer reports. Exported for tests. */
export const POSITION_POLL_MS = 500

/** The measured rect and its change key, or null while the placeholder is degenerate. */
const readPlaceholder = (el: HTMLElement | null): NativeViewRect | null => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height }
  // A degenerate rect is NOT a small view — it's a placeholder that is hidden,
  // unmounted, or mid-transition through a dock switch. Pushing one parks a
  // zero-size (or negative) overlay over the placeholder, and Chromium reflows
  // the page to that size on the way through. Skipping holds the last good
  // bounds until the layout settles.
  //
  // A SMALL rect is a different thing entirely and must still be pushed — see
  // `isPaintableRect` for what happened when this guard couldn't tell the two
  // apart.
  return isPaintableRect(rect) ? rect : null
}

const rectKey = (r: NativeViewRect): string =>
  `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`

/**
 * Every cheap signal that the placeholder may have moved or resized, wired to
 * `onSignal`; returns the disposer. See the module note for why each exists.
 */
const observePlaceholder = (el: HTMLElement | null, onSignal: () => void): (() => void) => {
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onSignal)
  if (el !== null) observer?.observe(el)
  window.addEventListener("resize", onSignal)
  document.addEventListener("transitionend", onSignal, true)
  document.addEventListener("animationend", onSignal, true)
  const poll = window.setInterval(onSignal, POSITION_POLL_MS)
  return () => {
    observer?.disconnect()
    window.removeEventListener("resize", onSignal)
    document.removeEventListener("transitionend", onSignal, true)
    document.removeEventListener("animationend", onSignal, true)
    window.clearInterval(poll)
  }
}

export function useNativeViewBounds({
  active,
  onFirstPaintableRect,
  onBoundsChanged
}: UseNativeViewBoundsOptions): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  // Held in refs so a fresh inline callback each render doesn't tear down and
  // restart observation — only `active` should do that.
  const onFirst = useRef(onFirstPaintableRect)
  onFirst.current = onFirstPaintableRect
  const onChanged = useRef(onBoundsChanged)
  onChanged.current = onBoundsChanged

  useEffect(() => {
    if (!active) return
    let last = ""
    let firstSeen = false
    let disposed = false
    let raf = 0

    /** One read; true once a paintable rect has been seen. */
    const measure = (): boolean => {
      const r = disposed ? null : readPlaceholder(ref.current)
      if (r === null) return firstSeen
      if (!firstSeen) {
        firstSeen = true
        onFirst.current(r)
      }
      const key = rectKey(r)
      if (key !== last) {
        last = key
        onChanged.current(r)
      }
      return true
    }

    // Settle loop: frame-by-frame ONLY until the placeholder first has a size.
    const settle = () => {
      raf = 0
      if (disposed || measure()) return
      raf = requestAnimationFrame(settle)
    }
    raf = requestAnimationFrame(settle)
    const stopObserving = observePlaceholder(ref.current, () => {
      measure()
    })

    return () => {
      disposed = true
      if (raf !== 0) cancelAnimationFrame(raf)
      stopObserving()
    }
  }, [active])

  return ref
}
