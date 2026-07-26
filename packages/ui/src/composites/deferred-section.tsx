import * as React from "react"

/**
 * Renders `children` only while the section is at or near the viewport, holding
 * its place with a plain spacer the rest of the time.
 *
 * ## Why this exists
 *
 * The Code Review tab stacks one `ReviewDiff` per changed file and scrolls them
 * continuously, and `ReviewDiff` is non-virtualized — a deliberate choice back
 * when the tab showed ONE file at a time, and small for exactly that reason. The
 * continuous scroll quietly turned "one small file" into "every line of every
 * file, all mounted": ~10 React fibers per line (a row div, two gutter spans, a
 * sign span, and one span per syntax token), so a 12k-line changeset mounts half
 * a million of them and holds ~320MB. A real branch across two panes is where
 * the multi-gigabyte renderer came from.
 *
 * Deferring per FILE rather than per row is what keeps this cheap: `ReviewDiff`
 * and its selection, drag, revert and comment logic are untouched, and a file's
 * syntax highlighting doesn't run until you can see it.
 *
 * ## Why the height is remembered, not just estimated
 *
 * A spacer that guesses wrong makes the scroll position lurch when the real
 * content swaps in. The estimate only ever has to carry a section that has NEVER
 * been on screen; the moment one mounts we measure it, and that measurement is
 * what the spacer uses from then on. Scrolling back up through a file you have
 * already read is therefore exact.
 */
export function DeferredSection({
  estimatedHeight,
  /**
   * Keep mounted regardless of position. The file the reviewer is working in
   * holds selection and an open comment composer in `ReviewDiff`'s own state,
   * and unmounting it would silently discard a half-written comment.
   */
  pinned = false,
  /** How far outside the viewport to start mounting. One screen is plenty. */
  rootMargin = "1200px 0px",
  children
}: {
  estimatedHeight: number
  pinned?: boolean
  rootMargin?: string
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [near, setNear] = React.useState(false)
  const [measured, setMeasured] = React.useState<number | null>(null)

  React.useEffect(() => {
    const el = ref.current
    if (el === null) return
    // No IntersectionObserver (jsdom, in the component tests) means no way to
    // know what is visible — so mount everything, which is the old behaviour and
    // the only safe answer.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setNear(entry.isIntersecting)
      },
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin])

  const mounted = near || pinned

  // Measure on the way in, so the spacer this section leaves behind is its real
  // height rather than the estimate. Layout effect, not effect: it runs before
  // paint, so nothing renders against a stale spacer height.
  React.useLayoutEffect(() => {
    if (!mounted) return
    const height = ref.current?.getBoundingClientRect().height ?? 0
    if (height > 0) setMeasured(height)
  }, [mounted, children])

  return (
    <div ref={ref} style={mounted ? undefined : { height: measured ?? estimatedHeight }}>
      {mounted ? children : null}
    </div>
  )
}
