import { type ReactNode, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { ChevronRight, File, Folder, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react"
import { cn } from "../../lib/cn.js"
import { SPRING } from "../../lib/motion.js"

export interface AISidebarItem { id: string; label: string; type?: "folder" | "file" | "item"; icon?: ReactNode; children?: ReadonlyArray<AISidebarItem>; badge?: ReactNode }
export function AISidebar({ items, activeId, onSelect, header, footer, defaultCollapsed = false, className }: { items: ReadonlyArray<AISidebarItem>; activeId?: string; onSelect?: (id: string) => void; header?: ReactNode; footer?: ReactNode; defaultCollapsed?: boolean; className?: string }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(items.filter(item => item.children).map(item => item.id)))
  const [query, setQuery] = useState("")
  const visible = items.filter(item => item.label.toLowerCase().includes(query.toLowerCase()) || item.children?.some(child => child.label.toLowerCase().includes(query.toLowerCase())))
  const row = (item: AISidebarItem, depth = 0): ReactNode => {
    const open = expanded.has(item.id)
    const Icon = item.type === "folder" ? Folder : item.type === "file" ? File : null
    return <div key={item.id}>{<button type="button" title={collapsed ? item.label : undefined} aria-current={item.id === activeId ? "page" : undefined} onClick={() => { if (item.children) setExpanded(current => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next }); else onSelect?.(item.id) }} className={cn("group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11.5px]", item.id === activeId ? "bg-surface font-medium text-text-bright" : "text-muted-foreground hover:bg-hover hover:text-text")} style={{ paddingLeft: collapsed ? 8 : 8 + depth * 14 }}>{item.children ? <ChevronRight className={cn("size-3 flex-none transition-transform", open && "rotate-90")} /> : <span className="w-3" />}{item.icon ?? (Icon && <Icon className="size-3.5 flex-none" />)}{!collapsed && <><span className="min-w-0 flex-1 truncate">{item.label}</span>{item.badge}</>}</button>}{!collapsed && item.children && open && <div>{item.children.map(child => row(child, depth + 1))}</div>}</div>
  }
  return <m.aside animate={{ width: collapsed ? 48 : 236 }} transition={SPRING} className={cn("flex min-h-0 flex-none flex-col overflow-hidden border-r border-line bg-panel", className)}><div className="flex h-11 items-center gap-2 border-b border-line px-2">{!collapsed && <div className="min-w-0 flex-1">{header}</div>}<button type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed(value => !value)} className="flex size-7 items-center justify-center rounded-md text-dim hover:bg-surface hover:text-text">{collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</button></div>{!collapsed && <label className="mx-2 mt-2 flex h-8 items-center gap-2 rounded-md border border-line bg-sunken px-2"><Search className="size-3.5 text-dim" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter" className="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-dim" /></label>}<nav className="min-h-0 flex-1 overflow-y-auto p-2">{visible.map(item => row(item))}</nav>{footer && !collapsed && <div className="border-t border-line p-2">{footer}</div>}</m.aside>
}

export function ChatApp({ sidebar, header, conversation, composer, auxiliary, className }: { sidebar?: ReactNode; header?: ReactNode; conversation: ReactNode; composer: ReactNode; auxiliary?: ReactNode; className?: string }) {
  return <div data-slot="beui-chat-app" className={cn("flex h-full min-h-0 overflow-hidden bg-editor text-text", className)}>{sidebar}<main className="flex min-w-0 flex-1 flex-col">{header && <header className="flex h-11 flex-none items-center border-b border-line bg-panel px-3">{header}</header>}<div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col"><div className="min-h-0 flex-1">{conversation}</div><div className="flex-none border-t border-line bg-panel/70 p-3">{composer}</div></section>{auxiliary && <aside className="w-72 flex-none overflow-y-auto border-l border-line bg-panel p-3">{auxiliary}</aside>}</div></main></div>
}
