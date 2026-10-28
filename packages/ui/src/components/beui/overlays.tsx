import { type ReactNode, useCallback, useId, useRef, useState } from "react"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import { cn } from "../../lib/cn.js"
import { FAST, SPRING, SPRING_SOFT } from "../../lib/motion.js"
import { Tooltip } from "./tooltip.js"
import { isGapMarker, windowRailItems, type RailItem } from "../../lib/window-rail-items.js"

export function SharedLayoutIndicator({ layoutId = "shared-active", className }: { layoutId?: string; className?: string }) {
  return <m.span layoutId={layoutId} transition={SPRING} className={cn("absolute inset-0 -z-10 rounded-md bg-surface", className)} />
}

/** Tick colour: amber needs-you, red failed, blue checkpoint. Unmarked ticks stay neutral. */
export type PreviewRailItemKind = "needs-you" | "failed" | "checkpoint"
export interface PreviewRailItem extends RailItem { description?: ReactNode; ariaLabel?: string; kind?: PreviewRailItemKind; /** Caption above the title, e.g. `Turn 3 · 4 files · +84 −12`. */ meta?: ReactNode }
export interface PreviewRailProps {
  items: ReadonlyArray<PreviewRailItem>
  label?: string
  activeId?: string
  defaultActiveId?: string
  onActiveChange?: (id: string) => void
  onItemSelect?: (item: PreviewRailItem) => void
  /** Backward-compatible alias used by the catalog story. */
  onSelect?: (item: PreviewRailItem) => void
  /** Makes the hover card interactive: it stays open under the pointer and shows these controls. */
  renderActions?: (item: PreviewRailItem) => ReactNode
  showPreview?: boolean
  previewSide?: "before" | "after"
  highlightActive?: boolean
  itemSize?: number
  maxItems?: number
  children?: ReactNode
  className?: string
  railClassName?: string
  previewContainerClassName?: string
  previewClassName?: string
}
// Expansion is keyed to the first item, so switching sessions collapses the rail again.
function useWindowedRail<T extends RailItem>(items: ReadonlyArray<T>, activeId: string, maxItems?: number) {
  const firstId = items[0]?.id
  const [expandedFor, setExpandedFor] = useState<string | undefined>()
  const expanded = expandedFor !== undefined && expandedFor === firstId
  const windowedItems = maxItems ? windowRailItems(items, activeId, expanded, maxItems) : items
  return { windowedItems, expand: () => setExpandedFor(firstId) }
}

const TICK_KIND_CLASS: Record<PreviewRailItemKind, string> = { "needs-you": "text-state-needs", failed: "text-state-failed", checkpoint: "text-state-working" }
// Leaving the tick for the card crosses a few px; the delay keeps the card from closing in transit.
const CARD_LEAVE_MS = 150

function RailCardContent({ item, actions }: { item: PreviewRailItem; actions?: ReactNode }) {
  return <div data-slot="preview-rail-card" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
    {item.meta && <p data-slot="preview-rail-meta" className="mb-1 text-xs text-muted-foreground">{item.meta}</p>}
    <p data-slot="preview-rail-title" className="font-medium text-text-bright">{item.label}</p>
    {item.description && <div data-slot="preview-rail-description" className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</div>}
    {actions && <div data-slot="preview-rail-actions" className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
  </div>
}

interface CardHover { enter(): void; leave(): void; focus(): void; blur(): void }

function RailPreviewCard({ item, layoutId, reduce, side, className, actions, hover }: { item: PreviewRailItem; layoutId: string; reduce: boolean; side: "before" | "after"; className?: string; actions?: ReactNode; hover?: CardHover }) {
  // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus bridging only keeps the card open while the pointer travels from the tick onto it.
  return <div onPointerEnter={hover?.enter} onPointerLeave={hover?.leave} onFocus={hover?.focus} onBlur={hover?.blur} className={cn("w-full max-w-sm", side === "before" && "ml-auto", hover && "pointer-events-auto", className)}><m.div layoutId={layoutId} transition={reduce ? { duration: 0 } : SPRING}><AnimatePresence mode="wait" initial={false}><m.div key={item.id} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -2, filter: "blur(4px)" }} transition={FAST}><RailCardContent item={item} actions={actions} /></m.div></AnimatePresence></m.div></div>
}

const TICK_SCALES = [1, 0.68, 0.44]
const tickScale = (highlighted: boolean, distance: number) => (highlighted ? 1 : (TICK_SCALES[distance] ?? 0.25))

function RailGapButton({ hiddenCount, height, onExpand }: { hiddenCount: number; height: number; onExpand: () => void }) {
  const label = `${hiddenCount} earlier turn${hiddenCount === 1 ? "" : "s"}`
  return (
    <Tooltip content={label} side="left" className="text-xs">
      <button type="button" aria-label={`Show ${label}`} onClick={onExpand} style={{ height }} className="relative flex h-6 w-12 items-center justify-center text-[10px] leading-none text-muted-foreground outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring">
        <span className="rounded-sm bg-line px-1 py-0.5">+{hiddenCount}</span>
      </button>
    </Tooltip>
  )
}

export function PreviewRail({ renderActions, items, label = "Section navigation", activeId, defaultActiveId, onActiveChange, onItemSelect, onSelect, showPreview = true, previewSide = "after", highlightActive = false, itemSize = 24, maxItems, children, className, railClassName, previewContainerClassName, previewClassName }: PreviewRailProps) {
         function getActiveItemId() {
           return (items.some(item => item.id === requestedActiveId) ? requestedActiveId : (items[0]?.id ?? ""))
         }

  const uid = useId()
  const reduce = useReducedMotion() ?? false
  const [internalActiveId, setInternalActiveId] = useState(defaultActiveId ?? items[0]?.id ?? "")
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  
  const requestedActiveId = activeId ?? internalActiveId
  const selectedId = getActiveItemId()
  const displayedId = hoveredId ?? focusedId ?? ""
  const highlightedId = displayedId || (highlightActive ? selectedId : "")
  
  const { windowedItems, expand: setExpanded } = useWindowedRail(items, selectedId, maxItems)
  const displayedIndex = windowedItems.findIndex(item => !isGapMarker(item) && item.id === highlightedId)
  const rowTemplate = windowedItems.length ? `repeat(${windowedItems.length}, ${itemSize}px)` : undefined
  
  const interactive = renderActions !== undefined
  const leaveTimer = useRef<number | undefined>(undefined)
  const hold = () => window.clearTimeout(leaveTimer.current)
  const release = (clear: () => void) => {
    if (!interactive) return clear()
    hold()
    leaveTimer.current = window.setTimeout(clear, CARD_LEAVE_MS)
  }
  const clearHover = () => setHoveredId(null)
  const clearFocus = () => setFocusedId(null)

  const selectItem = useCallback((item: PreviewRailItem) => {
    if (activeId === undefined) setInternalActiveId(item.id)
    onActiveChange?.(item.id)
    onItemSelect?.(item)
    onSelect?.(item)
  }, [activeId, onActiveChange, onItemSelect, onSelect])

  return <m.div layoutRoot className={cn("isolate relative flex min-h-80 w-full overflow-visible", className)}>
    <nav aria-label={label} onPointerLeave={() => release(clearHover)} style={{ gridTemplateRows: rowTemplate }} className={cn("relative z-10 grid w-12 shrink-0 content-center", railClassName)}>
      {windowedItems.map((item, index) => {
        if (isGapMarker(item)) return <RailGapButton key={`gap-${item.firstHiddenId}`} hiddenCount={item.hiddenCount} height={itemSize} onExpand={setExpanded} />
        const selected = item.id === selectedId
        const highlighted = item.id === highlightedId
        const scale = item.kind ? 1 : tickScale(highlighted, displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex))
        return <button key={item.id} data-slot="preview-rail-item" type="button" aria-label={item.ariaLabel ?? item.label} aria-current={selected ? "location" : undefined} onPointerEnter={event => { if (event.pointerType !== "touch") { hold(); setHoveredId(item.id) } }} onFocus={event => { if (event.currentTarget.matches(":focus-visible")) { hold(); setFocusedId(item.id) } }} onBlur={() => release(clearFocus)} onClick={() => selectItem(item)} style={{ height: itemSize }} className="relative flex h-6 w-12 items-center text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span data-slot="preview-rail-tick" data-kind={item.kind} aria-hidden="true" style={{ transform: `scaleX(${scale})` }} className={cn("block h-0.5 w-12 origin-left bg-current transition-transform duration-200 ease-out motion-reduce:duration-0", item.kind ? TICK_KIND_CLASS[item.kind] : highlighted && "text-text-bright")} />
        </button>
      })}
    </nav>
    {showPreview && <div aria-hidden={interactive ? undefined : "true"} style={{ gridTemplateRows: rowTemplate }} className={cn("pointer-events-none absolute inset-y-0 z-50 grid content-center", previewSide === "before" ? "right-16 left-4" : "right-4 left-16", previewContainerClassName)}>
      {windowedItems.map(item => {
        if (isGapMarker(item)) return <div key={`gap-preview-${item.firstHiddenId}`} style={{ height: itemSize }} />
        return <div key={item.id} style={{ height: itemSize }} className="relative flex items-center">{item.id === displayedId && <RailPreviewCard item={item} layoutId={`preview-rail-card-${uid}`} reduce={reduce} side={previewSide} className={previewClassName} actions={renderActions?.(item)} hover={interactive ? { enter: () => { hold(); setHoveredId(item.id) }, leave: () => release(clearHover), focus: () => { hold(); setFocusedId(item.id) }, blur: () => release(clearFocus) } : undefined} />}</div>
      })}
    </div>}
    {children && <div className="min-h-0 min-w-0 flex-1">{children}</div>}
  </m.div>
}

export function Dock({ items, activeId, onSelect, className }: { items: ReadonlyArray<{ id: string; icon: ReactNode; label: string }>; activeId?: string; onSelect?: (id: string) => void; className?: string }) {
  return <div role="toolbar" className={cn("inline-flex items-end gap-1 rounded-xl border border-line bg-panel/95 p-1.5 shadow-xl", className)}>{items.map(item => <button key={item.id} type="button" aria-label={item.label} onClick={() => onSelect?.(item.id)} className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-text"><m.span whileHover={{ y: -3, scale: 1.12 }} transition={SPRING_SOFT}>{item.icon}</m.span>{item.id === activeId && <m.span layoutId="dock-active" className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-brand" />}</button>)}</div>
}
