import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { AnimatePresence, m, useMotionValue, useTransform } from "motion/react"
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

export interface PreviewRailItem { id: string; label: string; description?: string; ariaLabel?: string }
export function PreviewRail({ items, activeId, onSelect, label = "Preview navigation", className }: { items: ReadonlyArray<PreviewRailItem>; activeId?: string; onSelect?: (item: PreviewRailItem) => void; label?: string; className?: string }) {
  return <nav aria-label={label} className={cn("flex flex-col items-center gap-1 py-2", className)}>{items.map((item, index) => <Tooltip key={item.id} side="left" label={<><strong className="block text-text-bright">{item.label}</strong>{item.description && <span className="text-dim">{item.description}</span>}</>}><button type="button" aria-label={item.ariaLabel ?? item.label} aria-current={item.id === activeId ? "true" : undefined} onClick={() => onSelect?.(item)} className="group flex h-3 w-8 items-center justify-center"><m.span animate={{ width: item.id === activeId ? 24 : 8 + Math.min(index % 4, 3) * 3 }} transition={SPRING} className={cn("h-0.5 rounded-full", item.id === activeId ? "bg-brand" : "bg-line-strong group-hover:bg-muted-foreground")} /></button></Tooltip>)}</nav>
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
