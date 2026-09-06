import { type ReactNode, useCallback, useId, useState } from "react"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import { cn } from "../../lib/cn.js"
import { FAST, SPRING, SPRING_SOFT } from "../../lib/motion.js"

export function SharedLayoutIndicator({ layoutId = "shared-active", className }: { layoutId?: string; className?: string }) {
  return <m.span layoutId={layoutId} transition={SPRING} className={cn("absolute inset-0 -z-10 rounded-md bg-surface", className)} />
}

export interface PreviewRailItem { id: string; label: string; description?: ReactNode; ariaLabel?: string }
export interface PreviewRailProps {
  items: ReadonlyArray<PreviewRailItem>
  label?: string
  activeId?: string
  defaultActiveId?: string
  onActiveChange?: (id: string) => void
  onItemSelect?: (item: PreviewRailItem) => void
  /** Backward-compatible alias used by the catalog story. */
  onSelect?: (item: PreviewRailItem) => void
  showPreview?: boolean
  previewSide?: "before" | "after"
  highlightActive?: boolean
  itemSize?: number
  children?: ReactNode
  className?: string
  railClassName?: string
  previewContainerClassName?: string
  previewClassName?: string
}
export function PreviewRail({ items, label = "Section navigation", activeId, defaultActiveId, onActiveChange, onItemSelect, onSelect, showPreview = true, previewSide = "after", highlightActive = false, itemSize = 24, children, className, railClassName, previewContainerClassName, previewClassName }: PreviewRailProps) {
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
  const displayedIndex = items.findIndex(item => item.id === highlightedId)
  const rowTemplate = items.length ? `repeat(${items.length}, ${itemSize}px)` : undefined
  const selectItem = useCallback((item: PreviewRailItem) => {
    if (activeId === undefined) setInternalActiveId(item.id)
    onActiveChange?.(item.id)
    onItemSelect?.(item)
    onSelect?.(item)
  }, [activeId, onActiveChange, onItemSelect, onSelect])

  return <m.div layoutRoot className={cn("isolate relative flex min-h-80 w-full overflow-visible", className)}>
    <nav aria-label={label} onPointerLeave={() => setHoveredId(null)} style={{ gridTemplateRows: rowTemplate }} className={cn("relative z-10 grid w-12 shrink-0 content-center", railClassName)}>
      {items.map((item, index) => {
        const selected = item.id === selectedId
        const highlighted = item.id === highlightedId
        const distance = displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex)
        const scale = highlighted ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25
        return <button key={item.id} data-slot="preview-rail-item" type="button" aria-label={item.ariaLabel ?? item.label} aria-current={selected ? "location" : undefined} onPointerEnter={event => { if (event.pointerType !== "touch") setHoveredId(item.id) }} onFocus={event => { if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id) }} onBlur={() => setFocusedId(null)} onClick={() => selectItem(item)} style={{ height: itemSize }} className="relative flex h-6 w-12 items-center text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span data-slot="preview-rail-tick" aria-hidden="true" style={{ transform: `scaleX(${scale})` }} className={cn("block h-0.5 w-12 origin-left bg-current transition-transform duration-200 ease-out motion-reduce:duration-0", highlighted && "text-text-bright")} />
        </button>
      })}
    </nav>
    {showPreview && <div aria-hidden="true" style={{ gridTemplateRows: rowTemplate }} className={cn("pointer-events-none absolute inset-y-0 z-50 grid content-center", previewSide === "before" ? "right-16 left-4" : "right-4 left-16", previewContainerClassName)}>
      {items.map(item => <div key={item.id} style={{ height: itemSize }} className="relative flex items-center">{item.id === displayedId && <div className={cn("w-full max-w-sm", previewSide === "before" && "ml-auto", previewClassName)}><m.div layoutId={`preview-rail-card-${uid}`} transition={reduce ? { duration: 0 } : SPRING}><AnimatePresence mode="wait" initial={false}><m.div key={item.id} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -2, filter: "blur(4px)" }} transition={FAST}><div data-slot="preview-rail-card" className="rounded-2xl border border-line bg-panel p-4 shadow-sm"><p data-slot="preview-rail-title" className="font-medium text-text-bright">{item.label}</p>{item.description && <div data-slot="preview-rail-description" className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</div>}</div></m.div></AnimatePresence></m.div></div>}</div>)}
    </div>}
    {children && <div className="min-h-0 min-w-0 flex-1">{children}</div>}
  </m.div>
}

export function Dock({ items, activeId, onSelect, className }: { items: ReadonlyArray<{ id: string; icon: ReactNode; label: string }>; activeId?: string; onSelect?: (id: string) => void; className?: string }) {
  return <div role="toolbar" className={cn("inline-flex items-end gap-1 rounded-xl border border-line bg-panel/95 p-1.5 shadow-xl", className)}>{items.map(item => <button key={item.id} type="button" aria-label={item.label} onClick={() => onSelect?.(item.id)} className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-text"><m.span whileHover={{ y: -3, scale: 1.12 }} transition={SPRING_SOFT}>{item.icon}</m.span>{item.id === activeId && <m.span layoutId="dock-active" className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-brand" />}</button>)}</div>
}
