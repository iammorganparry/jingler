import * as React from "react"

/**
 * Measures an element's own width and re-renders when it changes.
 *
 * Deliberately measures the CONTAINER, not the window. A pane in a four-way
 * split can be 200px wide on a 4K display — anything keyed off `window.innerWidth`
 * would leave that pane's tab bar overflowing while insisting the app is "wide".
 *
 * Updates are coalesced to one per animation frame: a drag on a `ResizeHandle`
 * fires `ResizeObserver` at pointer-move rate, and letting each one through
 * re-renders every subtree that reads the width. The frame is cancelled on
 * unmount so a pane closed mid-drag doesn't setState on a dead component.
 *
 * Takes one synchronous layout measurement before subscribing. That prevents a
 * newly mounted pane from briefly rendering the wide layout and also keeps the
 * hook correct in test/runtime environments whose ResizeObserver shim only
 * implements subscription bookkeeping.
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T | null>,
  number
] {
  const ref = React.useRef<T | null>(null)
  const [width, setWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const initialWidth = el.getBoundingClientRect().width
    setWidth(initialWidth)

    // jsdom (unit tests) and any exotic runtime without ResizeObserver keep the
    // static measurement above rather than throwing.
    if (typeof ResizeObserver === "undefined") {
      return
    }

    let frame = 0
    let pending = -1

    const flush = () => {
      frame = 0
      // Guard against the no-op render: ResizeObserver reports sub-pixel
      // changes on every zoom step, and the tier only cares about whole pixels.
      setWidth((current) => (Math.round(pending) === Math.round(current) ? current : pending))
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      // `borderBoxSize` is the spec'd path; `contentRect` is the fallback for
      // older Chromium builds Electron may still be pinned to.
      pending = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
      if (frame === 0) frame = requestAnimationFrame(flush)
    })

    observer.observe(el)
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  return [ref, width]
}
