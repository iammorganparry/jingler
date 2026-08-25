import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react"
import { AnimatePresence, m, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { ChevronDown, GripHorizontal, PanelLeftClose, PanelLeftOpen, X } from "lucide-react"
import { cn } from "../../lib/cn.js"
import { FAST, SPRING, SPRING_SOFT } from "../../lib/motion.js"
import { Tooltip } from "../tooltip.js"
import { ContextMenu } from "../context-menu.js"
import { Popover, PopoverContent, PopoverTrigger } from "../popover.js"

export function BottomSheet({ open, onOpenChange, title, children, className }: { open: boolean; onOpenChange?: (open: boolean) => void; title?: ReactNode; children: ReactNode; className?: string }) {
  return <AnimatePresence>{open && <><m.button type="button" aria-label="Close sheet" onClick={() => onOpenChange?.(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FAST} className="fixed inset-0 z-40 bg-overlay" /><m.section role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Sheet"} initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SPRING} className={cn("fixed inset-x-3 bottom-3 z-50 max-h-[85vh] overflow-auto rounded-xl border border-line bg-panel p-4 shadow-2xl", className)}><div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />{title && <h2 className="mb-3 text-sm font-semibold text-text-bright">{title}</h2>}{children}</m.section></>}</AnimatePresence>
}

export function PullToRefresh({ onRefresh, children, threshold = 64, className }: { onRefresh: () => Promise<void> | void; children: ReactNode; threshold?: number; className?: string }) {
  const y = useMotionValue(0)
  const opacity = useTransform(y, [0, threshold], [0, 1])
  const [refreshing, setRefreshing] = useState(false)
  return <m.div drag={refreshing ? false : "y"} dragConstraints={{ top: 0, bottom: threshold * 1.4 }} dragElastic={0.35} style={{ y }} onDragEnd={async (_, info) => { if (info.offset.y < threshold) return; setRefreshing(true); await onRefresh(); setRefreshing(false); y.set(0) }} className={cn("relative", className)}><m.div aria-live="polite" style={{ opacity }} className="absolute inset-x-0 -top-8 text-center text-[11px] text-muted-foreground">{refreshing ? "Refreshing…" : "Release to refresh"}</m.div>{children}</m.div>
}

export function SharedLayoutIndicator({ layoutId = "shared-active", className }: { layoutId?: string; className?: string }) {
  return <m.span layoutId={layoutId} transition={SPRING} className={cn("absolute inset-0 -z-10 rounded-md bg-surface", className)} />
}

export function SharedLayoutBackground({ items, activeId, onSelect, className }: { items: ReadonlyArray<{ id: string; label: ReactNode }>; activeId?: string; onSelect?: (id: string) => void; className?: string }) {
  const group = useId()
  return <div className={cn("flex gap-1", className)}>{items.map(item => <button key={item.id} type="button" onClick={() => onSelect?.(item.id)} className="relative rounded-md px-2.5 py-1.5 text-[12px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">{activeId === item.id && <m.span layoutId={`${group}-bg`} transition={SPRING} className="absolute inset-0 -z-10 rounded-md bg-surface" />}{item.label}</button>)}</div>
}

export function BounceSidebar({ items, activeId, onSelect, className }: { items: ReadonlyArray<{ id: string; icon: ReactNode; label: string }>; activeId: string; onSelect?: (id: string) => void; className?: string }) {
  return <nav className={cn("flex flex-col gap-1 rounded-lg border border-line bg-panel p-1.5", className)}>{items.map(item => <button key={item.id} type="button" aria-current={item.id === activeId ? "page" : undefined} onClick={() => onSelect?.(item.id)} className="relative flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-surface hover:text-text"><span className="flex size-4 items-center justify-center">{item.icon}</span>{item.label}{item.id === activeId && <m.span layoutId="bounce-sidebar-dot" transition={SPRING_SOFT} className="absolute right-2 size-1.5 rounded-full bg-brand" />}</button>)}</nav>
}

export function AnimatedSidebar({ open, onOpenChange, children, className }: { open: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode; className?: string }) {
  return <m.aside animate={{ width: open ? 240 : 48 }} transition={SPRING} className={cn("overflow-hidden border-r border-line bg-panel", className)}><button type="button" aria-label={open ? "Collapse sidebar" : "Expand sidebar"} onClick={() => onOpenChange?.(!open)} className="m-2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-text">{open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}</button><div className={cn("min-w-[240px] transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")}>{children}</div></m.aside>
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
  const uid = useId()
  const reduce = useReducedMotion() ?? false
  const [internalActiveId, setInternalActiveId] = useState(defaultActiveId ?? items[0]?.id ?? "")
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const requestedActiveId = activeId ?? internalActiveId
  const selectedId = items.some(item => item.id === requestedActiveId) ? requestedActiveId : (items[0]?.id ?? "")
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

export function MotionTooltip({ trigger, children, side = "top" }: { trigger: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return <Tooltip label={children} side={side}>{trigger}</Tooltip>
}

export function AnimatedContextMenu({ trigger, items }: { trigger: ReactNode; items: ReadonlyArray<{ id: string; label: string; onSelect?: () => void; disabled?: boolean }> }) {
  return <ContextMenu items={items.map(item => ({ id: item.id, label: item.label, onSelect: item.disabled ? () => {} : (item.onSelect ?? (() => {})) }))}>{trigger}</ContextMenu>
}

export function MotionPopover({ trigger, children, align = "center" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "center" | "end" }) {
  return <Popover><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent align={align} className="origin-[var(--radix-popover-content-transform-origin)] animate-in fade-in zoom-in-95">{children}</PopoverContent></Popover>
}

export function MorphingModal({ open, onOpenChange, title, children, className }: { open: boolean; onOpenChange?: (open: boolean) => void; title?: ReactNode; children: ReactNode; className?: string }) {
  useEffect(() => { if (!open) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange?.(false) }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key) }, [open, onOpenChange])
  return <AnimatePresence>{open && <><m.button type="button" aria-label="Close modal" onClick={() => onOpenChange?.(false)} className="fixed inset-0 z-40 bg-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} /><m.section role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Dialog"} layout initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -8 }} transition={SPRING} className={cn("fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-line bg-panel p-4 shadow-2xl", className)}><div className="mb-3 flex items-center gap-3"><h2 className="min-w-0 flex-1 font-semibold text-text-bright">{title}</h2><button type="button" aria-label="Close" onClick={() => onOpenChange?.(false)} className="rounded-md p-1 text-dim hover:bg-surface hover:text-text"><X className="size-4" /></button></div>{children}</m.section></>}</AnimatePresence>
}

export function CenterMorphModal(props: Parameters<typeof MorphingModal>[0]) { return <MorphingModal {...props} className={cn("origin-center", props.className)} /> }

export function BouncyAccordion({ items, value, onValueChange, className }: { items: ReadonlyArray<{ id: string; title: ReactNode; content: ReactNode; icon?: ReactNode }>; value?: string; onValueChange?: (id?: string) => void; className?: string }) {
  const [local, setLocal] = useState<string>()
  const current = value ?? local
  const setCurrent = (id?: string) => { if (value === undefined) setLocal(id); onValueChange?.(id) }
  return <div className={cn("divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel", className)}>{items.map(item => { const open = current === item.id; return <div key={item.id}><button type="button" aria-expanded={open} onClick={() => setCurrent(open ? undefined : item.id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] text-text hover:bg-surface">{item.icon}<span className="flex-1">{item.title}</span><m.span animate={{ rotate: open ? 180 : 0 }} transition={SPRING}><ChevronDown className="size-3.5" /></m.span></button><AnimatePresence initial={false}>{open && <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING} className="overflow-hidden"><div className="px-3 pb-3 text-[12px] text-muted-foreground">{item.content}</div></m.div>}</AnimatePresence></div>})}</div>
}

export function Drawer({ open, onOpenChange, side = "right", title, children, className }: { open: boolean; onOpenChange?: (open: boolean) => void; side?: "left" | "right"; title?: ReactNode; children: ReactNode; className?: string }) {
  return <AnimatePresence>{open && <><m.button type="button" aria-label="Close drawer" onClick={() => onOpenChange?.(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 bg-overlay" /><m.aside role="dialog" aria-modal="true" initial={{ x: side === "left" ? "-100%" : "100%" }} animate={{ x: 0 }} exit={{ x: side === "left" ? "-100%" : "100%" }} transition={SPRING} className={cn("fixed inset-y-0 z-50 w-[min(400px,90vw)] border-line bg-panel p-4 shadow-2xl", side === "left" ? "left-0 border-r" : "right-0 border-l", className)}><div className="mb-3 flex items-center"><h2 className="flex-1 font-semibold text-text-bright">{title}</h2><button type="button" aria-label="Close" onClick={() => onOpenChange?.(false)}><X className="size-4" /></button></div>{children}</m.aside></>}</AnimatePresence>
}
