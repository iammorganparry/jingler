import { type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "../lib/cn.js"
import { useContainerWidth } from "../hooks/use-container-width.js"
import { FAST, INSTANT, paneVariants, SPRING } from "../lib/motion.js"
import { maxPanesForWidth, MIN_RATIO, type Pane, type SplitGroup, SESSION_DND_MIME } from "./split-layout.js"

/**
 * Where a dragged session would land relative to the pane it's hovering.
 *
 * Arc's three zones, and the names are the semantics: the outer eighths of a
 * pane INSERT a new pane on that side, the middle REPLACES what's there. Edge
 * zones are deliberately narrow — replacing is the commoner intent, and a wide
 * edge zone means every casual drop splits when you meant to swap.
 */
export type DropZone = "before" | "after" | "replace"

/** Fraction of a pane's width that counts as its insert edge. */
const EDGE_FRACTION = 0.125

const zoneAt = (e: DragEvent<HTMLElement>): DropZone => {
  const box = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - box.left) / (box.width || 1)
  if (x < EDGE_FRACTION) return "before"
  if (x > 1 - EDGE_FRACTION) return "after"
  return "replace"
}

/**
 * Whether a drag carries one of our session rows.
 *
 * Checks `types`, not the value: during `dragover` the spec blanks `getData` (so
 * a page can't snoop on what's being dragged over it), and only `types` is
 * readable. Getting this wrong means either accepting file drops or rejecting
 * every session drop.
 */
const carriesPayload = (e: DragEvent, mime: string): boolean =>
  Array.from(e.dataTransfer.types).includes(mime)

export interface SplitViewProps<TPane extends { readonly ratio: number } = Pane> {
  /** The split on screen. `null` renders the empty state. */
  group: Pick<SplitGroup, "focused"> & { readonly panes: ReadonlyArray<TPane> } | null
  /**
   * One pane's contents. A prop rather than a hard dependency on `SessionPane`
   * so this component stays mountable in Storybook with cheap placeholders —
   * the whole point of approving the split's feel before wiring it to the app.
   */
  renderPane: (pane: TPane, index: number) => ReactNode
  /** Stable identity for animation. Defaults to the outer session pane id. */
  paneId?: (pane: TPane) => string
  /** Custom payload type for nested tab splits. */
  dragMime?: string
  /** Selector prefix; nested splits use `surface` to avoid outer-pane collisions. */
  testIdPrefix?: string
  /** Width-derived capacity; inner surfaces can use a smaller readable floor. */
  paneCapacity?: (width: number) => number
  /** Move the focus ring (and, downstream, singleton ownership) to a pane. */
  onFocusPane?: (index: number) => void
  /** A session was dropped. `at` is the pane index it should occupy. */
  onSplitWith?: (sessionId: string, at: number) => void
  /** A session was dropped onto a pane's middle — swap that pane's session. */
  onReplacePane?: (index: number, sessionId: string) => void
  /**
   * Commit the divider after pane `index`, as a fraction of the row's width.
   * Pointer moves are previewed directly in the DOM; one delta arrives on release.
   */
  onResize?: (index: number, delta: number) => void
  /** Shown when there is no group at all — first launch, or everything closed. */
  emptyState?: ReactNode
}

/**
 * The split — one animated pane per session in the active group.
 *
 * A flex row of `flexGrow`-weighted children rather than a CSS grid: the panes
 * trade width continuously as a divider is dragged, and `flexGrow` is the one
 * property where "these three share the row in this proportion" is a single
 * number per child that the browser resolves in one pass.
 *
 * Panes are keyed by SESSION ID, not by index. That's what lets a pane keep its
 * subtree — and so its transcript scroll position and virtualizer measurements —
 * when a pane to its left closes and every index shifts. It is also what makes
 * `motion`'s layout animation able to slide the survivor rather than cross-fade
 * a remount.
 */
export function SplitView<TPane extends { readonly ratio: number } = Pane>({
  group,
  renderPane,
  paneId = (pane) => (pane as unknown as Pane).sessionId,
  dragMime = SESSION_DND_MIME,
  testIdPrefix = "split",
  paneCapacity = maxPanesForWidth,
  onFocusPane,
  onSplitWith,
  onReplacePane,
  onResize,
  emptyState
}: SplitViewProps<TPane>) {
  const focusFromContent = (event: SyntheticEvent, index: number) => {
    // Toolbar actions already name their pane. Focusing first can publish a late
    // active-chat update that reopens the pane immediately after it was closed.
    if (event.target instanceof Element && event.target.closest("[data-pane-toolbar]")) return
    onFocusPane?.(index)
  }
  const renderSplitPaneContainer = (pane: TPane, index: number) => {
  function getPaneTransition() {
    return (draggingDivider !== null ? INSTANT : switched ? FAST : SPRING)
  }

                                     function renderInsertIndicator() {
                                       return ((drop === "before" || drop === "after") && (
                <motion.span
                  layoutId={`${layoutScope}-insert-indicator`}
                  transition={SPRING}
                  data-testid={`${testIdPrefix}-insert-${drop}-${index}`}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 w-1 bg-blue",
                    drop === "before" ? "left-0" : "right-0",
                    // At the cap there is nowhere to insert, so the indicator
                    // says so rather than promising a pane that won't appear.
                    full && "bg-red/70"
                  )}
                />
              ))
                                     }

    if (!group) return null
          const isFocused = index === group.focused
          const drop = dropAt?.index === index ? dropAt.zone : null
          return (
            <motion.div
              key={paneId(pane)}
              // Position-only transforms keep text crisp and avoid per-frame wrapping/measurement.
              layout={paneLayout}
              variants={paneVariants}
              initial="hidden"
              animate="visible"
              transition={getPaneTransition()}
              // `order` interleaves the panes with the dividers, which are
              // rendered as a separate run below (see the note there).
              style={{ flexGrow: pane.ratio, flexBasis: 0, order: index * 2, contain: "layout paint" }}
              data-testid={`${testIdPrefix}-pane-${index}`}
              {...{ [`data-${testIdPrefix}-pane-index`]: index }}
              data-session={testIdPrefix === "split" ? paneId(pane) : undefined}
              data-surface={testIdPrefix === "surface" ? paneId(pane) : undefined}
              data-focused={isFocused || undefined}
              // Focus follows a mousedown anywhere in the pane, captured so a
              // click on a control inside still registers the pane as focused
              // first.
              onMouseDownCapture={(event) => focusFromContent(event, index)}
              onFocusCapture={(event) => focusFromContent(event, index)}
              onDragOver={(e) => {
                if (!(onSplitWith || onReplacePane)) return
                if (!carriesPayload(e, dragMime)) return
                // Calling preventDefault is what MARKS this element as a valid
                // drop target — without it the browser refuses the drop entirely.
                e.preventDefault()
                e.dataTransfer.dropEffect = "move"
                const zone = zoneAt(e)
                setDropAt((current) =>
                  current?.index === index && current.zone === zone ? current : { index, zone }
                )
              }}
              onDragLeave={(e) => {
                // Ignore leaves into a descendant — only a real exit clears the
                // indicator, or it would strobe as the cursor crosses the pane.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDropAt((current) => (current?.index === index ? null : current))
              }}
              onDrop={handleDrop(index)}
              className={cn(
                "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-editor",
                testIdPrefix === "surface" && "rounded-xl border border-hairline",
                // The focus ring is noise when there's only one pane — with
                // nothing to disambiguate it would just be a permanent border.
                !single && isFocused && "ring-1 ring-inset ring-blue/40",
                // A replace-drop outranks the focus ring: mid-drag, what will
                // happen matters more than where focus happens to be.
                drop === "replace" && "ring-2 ring-inset ring-blue"
              )}
            >
              {renderPane(pane, index)}
              {/* The insert indicator is a bar on the edge the pane would appear
                  on — a whole-pane ring would say "replace", which is the other
                  gesture entirely. */}
              {renderInsertIndicator()}
            </motion.div>
          )
        }

  // Which pane is under the pointer mid-drag, and where it would land. Tracked
  // as one value rather than a per-pane boolean so exactly one indicator shows:
  // `dragleave` fires when crossing into a CHILD element too, so a per-pane flag
  // would flicker as the cursor moves over the transcript.
  const [dropAt, setDropAt] = useState<{ index: number; zone: DropZone } | null>(null)
  // A divider being dragged. While this is set, layout animation is suspended —
  // a spring chasing the pointer lags behind it, which feels like the divider
  // is stuck to elastic rather than to the cursor.
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null)
  const paneLayout = draggingDivider === null ? "position" : false
  // Doubles as the divider drag's reference box and as the source of the
  // width-derived pane cap below — one measurement, two uses.
  const [rowRef, rowWidth] = useContainerWidth<HTMLDivElement>()
  const dividerAbort = useRef<AbortController | null>(null)
  const layoutScope = useId()

  useEffect(() => () => dividerAbort.current?.abort(), [])

  const paneIds = group?.panes.map(paneId) ?? []
  const presence = useRef<{ ids: ReadonlyArray<string>; token: number }>({ ids: paneIds, token: 0 })
  /**
   * Is this update an EDIT of the split on screen, or a SWITCH to a different
   * one?
   *
   * An edit shares at least one session with what was here a moment ago — a pane
   * was added, closed, reordered or resized, and the panes that stayed should
   * visibly move to their new places. A switch shares none: the operator clicked
   * a different session (or a different group) in the sidebar, and nothing on
   * screen survives it.
   *
   * They were the same code path, so a plain chat switch played the split's
   * whole choreography — the outgoing pane collapsing to a sliver while the
   * incoming one grew out of one — which reads as a split being dismantled and
   * rebuilt rather than as navigation.
   */
  const switched =
    presence.current.ids.length > 0 &&
    paneIds.length > 0 &&
    paneIds.every((id) => !presence.current.ids.includes(id))
  const presenceKey = switched ? presence.current.token + 1 : presence.current.token
  // Derived-from-props state, written during render on purpose: the key has to
  // be right in THIS commit (a switch is only visible in the frame it happens),
  // so it can't wait for an effect. The write is idempotent — recomputing from
  // the new ids yields the same token — which is what makes React's development
  // double-render harmless here.
  if (
    presence.current.ids.length !== paneIds.length ||
    paneIds.some((id, i) => presence.current.ids[i] !== id)
  ) {
    presence.current = { ids: paneIds, token: presenceKey }
  }

  // A drag can end without any pane seeing `dragleave` — dropped outside the
  // window, cancelled with Escape, or aborted when the window loses focus —
  // which would leave the indicator painted until the next drag. `dragend` fires
  // on the source for all of those, so listen for it globally while one is lit.
  useEffect(() => {
    if (dropAt === null) return
    const clear = () => setDropAt(null)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [dropAt])

  /**
   * Divider drags run on POINTER capture rather than HTML5 drag-and-drop.
   *
   * Native drag events fire coarsely (and suppress the cursor), which is fine
   * for "drop this session there" and useless for a continuous resize. Pointer
   * capture also means the drag survives the pointer crossing into an iframe or
   * a terminal canvas, which a mousemove listener on the row would not.
   */
  const startDividerDrag = useCallback(
    (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      e.preventDefault()
      const row = rowRef.current
      const rowWidth = row?.getBoundingClientRect().width ?? 0
      const left = group?.panes[index]
      const right = group?.panes[index + 1]
      if (!row || rowWidth === 0 || !left || !right) return
      const leftElement = row.querySelector<HTMLElement>(`[data-${testIdPrefix}-pane-index="${index}"]`)
      const rightElement = row.querySelector<HTMLElement>(`[data-${testIdPrefix}-pane-index="${index + 1}"]`)
      if (!(leftElement && rightElement)) return

      const handle = e.currentTarget
      const pointerId = e.pointerId
      const startX = e.clientX
      const pair = left.ratio + right.ratio
      let committedDelta = 0
      dividerAbort.current?.abort()
      const controller = new AbortController()
      dividerAbort.current = controller
      handle.setPointerCapture?.(pointerId)
      setDraggingDivider(index)
      const move = (event: PointerEvent) => {
        const wanted = left.ratio + (event.clientX - startX) / rowWidth
        const nextLeft = Math.min(Math.max(wanted, MIN_RATIO), pair - MIN_RATIO)
        committedDelta = nextLeft - left.ratio
        // Pointer moves paint only the two flex weights. React commits the final
        // ratio once on release, so conversations, editors, and xterm do not
        // rerender at pointer frequency.
        leftElement.style.flexGrow = String(nextLeft)
        rightElement.style.flexGrow = String(pair - nextLeft)
      }
      const end = () => {
        controller.abort()
        dividerAbort.current = null
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
        if (committedDelta !== 0) onResize(index, committedDelta)
        setDraggingDivider(null)
      }
      const options = { signal: controller.signal }
      window.addEventListener("pointermove", move, options)
      window.addEventListener("pointerup", end, options)
      window.addEventListener("pointercancel", end, options)
      window.addEventListener("blur", end, options)
      handle.addEventListener("lostpointercapture", end, options)
    },
    [group, onResize, rowRef, testIdPrefix]
  )

  if (group === null) {
    return (
      <div data-testid={`${testIdPrefix}-view`} className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-editor">
        {emptyState}
      </div>
    )
  }

  const single = group.panes.length === 1
  // The cap is the row's, not the model's: four panes are legible at 1400px and
  // illegible at 900px, and the operator gets told which by the indicator
  // turning red rather than by dropping a session into a pane they can't read.
  const full = group.panes.length >= paneCapacity(rowWidth)

  const handleDrop = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    if (!carriesPayload(e, dragMime)) return
    e.preventDefault()
    const zone = zoneAt(e)
    setDropAt(null)
    const payload = e.dataTransfer.getData(dragMime)
    if (!payload) return
    // A REPLACE is always allowed — it doesn't change the pane count, so it
    // can't make the row narrower than it already is. Only an INSERT is refused,
    // and it's refused here rather than in the reducer so the same drop still
    // works the moment the window is widened.
    if (zone === "replace") {
      onReplacePane?.(index, payload)
      return
    }
    if (full) return
    onSplitWith?.(payload, zone === "before" ? index : index + 1)
  }

  return (
    <div
      ref={rowRef}
      data-testid={`${testIdPrefix}-view`}
      data-panes={group.panes.length}
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        testIdPrefix === "surface" ? "gap-1.5 bg-panel p-1.5" : "bg-hairline"
      )}
    >
      {/* Fresh sessions fade in; surviving panes keep their transcript state. */}
      <AnimatePresence key={presenceKey} initial={switched} mode="popLayout">
        {group.panes.map(renderSplitPaneContainer)}
      </AnimatePresence>

      {/* Dividers are siblings of the panes, not children, so a drag on one is
          never intercepted by the pane's own drop handling. They're rendered as
          a second run and woven back between the panes with flex `order`
          (pane N gets `2N`, the divider after it `2N+1`) — rendering them
          interleaved would put each divider inside a pane's drop target. */}
      {onResize &&
        group.panes.slice(0, -1).map((pane, index) => (
          <Divider
            key={`divider-${paneId(pane)}`}
            index={index}
            testIdPrefix={testIdPrefix}
            active={draggingDivider === index}
            onPointerDown={startDividerDrag(index)}
          />
        ))}

      {/*
        There was a ghost "Add right split" panel here — Arc's, a 40px strip
        pinned to the right edge of every split. It has been removed: it was on
        screen permanently to serve an occasional act, and the two gestures that
        actually express "put that session beside this one" both say WHICH
        session while they do it. ⌃⇧= and a drag from the sidebar are those
        gestures; the panel could only ever guess (`addNextSessionAsPane`).
      */}
    </div>
  )
}

/**
 * The drag handle between two panes.
 *
 * One pixel of visible hairline, eight pixels of hit area. A divider you have to
 * aim at is a divider you avoid using; the negative margins let the target
 * overhang its neighbours without taking a pixel of layout from them.
 */
function Divider({
  index,
  testIdPrefix,
  active,
  onPointerDown
}: {
  index: number
  testIdPrefix: string
  active: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize pane ${index + 1}`}
      data-testid={`${testIdPrefix}-divider-${index}`}
      data-active={active || undefined}
      onPointerDown={onPointerDown}
      // `-order` places each divider immediately after its pane: flex `order`
      // is the only way to interleave siblings that are rendered as two separate
      // runs, and rendering them interleaved would nest the divider inside the
      // pane's drop target.
      style={{ order: index * 2 + 1 }}
      className={cn(
        // The hairline is ALWAYS drawn, not just on hover: two transcripts flush
        // against each other read as one wrapped column. It doubles as the
        // affordance — the line you can see is the line you can grab.
        "relative z-10 -mx-1 w-2 flex-none cursor-col-resize touch-none",
        "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
        active ? "after:bg-blue" : "after:bg-hairline hover:after:bg-blue/50"
      )}
    />
  )
}
