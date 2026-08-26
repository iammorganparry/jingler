import { type CSSProperties, type ReactNode, useMemo, useRef, useState } from "react"
import { m, useMotionValue, useSpring, useTransform } from "motion/react"
import { MeshGradient } from "@paper-design/shaders-react"
import { cn } from "../../lib/cn.js"
import { SPRING, SPRING_SOFT } from "../../lib/motion.js"

export function TiltCard({ children, className, intensity = 8 }: { children: ReactNode; className?: string; intensity?: number }) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [intensity, -intensity]), SPRING_SOFT)
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-intensity, intensity]), SPRING_SOFT)
  return <m.div style={{ rotateX, rotateY, transformPerspective: 800 }} onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); x.set((event.clientX - rect.left) / rect.width - .5); y.set((event.clientY - rect.top) / rect.height - .5) }} onPointerLeave={() => { x.set(0); y.set(0) }} className={cn("relative overflow-hidden rounded-xl border border-line bg-panel", className)}>{children}<m.span aria-hidden style={{ opacity: useTransform(x, [-.5,0,.5],[.15,0,.15]) }} className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/20 via-transparent to-transparent" /></m.div>
}

export interface DataTableColumn<Row> { id: string; header: ReactNode; cell: (row: Row) => ReactNode; sortValue?: (row: Row) => string | number; width?: number }
export function DataTable<Row extends { id: string }>({ rows, columns, selected = [], onSelectionChange, className }: { rows: ReadonlyArray<Row>; columns: ReadonlyArray<DataTableColumn<Row>>; selected?: ReadonlyArray<string>; onSelectionChange?: (ids: string[]) => void; className?: string }) {
  const [sort, setSort] = useState<{ id: string; direction: 1 | -1 }>()
  const ordered = useMemo(() => { if (!sort) return rows; const column = columns.find(item => item.id === sort.id); if (!column?.sortValue) return rows; return [...rows].sort((a,b) => String(column.sortValue!(a)).localeCompare(String(column.sortValue!(b)), undefined, { numeric: true }) * sort.direction) }, [columns, rows, sort])
  const toggle = (id: string) => onSelectionChange?.(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id])
  return <div className={cn("overflow-auto rounded-lg border border-line", className)}><table className="w-full border-collapse text-left text-[12px]"><thead className="sticky top-0 bg-panel text-muted-foreground"><tr>{onSelectionChange && <th className="w-8 p-2" />}{columns.map(column => <th key={column.id} style={{ width: column.width }} className="border-b border-line px-3 py-2 font-medium"><button type="button" onClick={() => column.sortValue && setSort(current => ({ id: column.id, direction: current?.id === column.id ? (current.direction * -1) as 1 | -1 : 1 }))}>{column.header}{sort?.id === column.id ? sort.direction === 1 ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>{ordered.map(row => <tr key={row.id} className={cn("border-b border-line/60 last:border-0 hover:bg-surface", selected.includes(row.id) && "bg-selection")} onClick={() => onSelectionChange && toggle(row.id)}>{onSelectionChange && <td className="p-2 text-center"><input type="checkbox" aria-label={`Select ${row.id}`} checked={selected.includes(row.id)} onChange={() => toggle(row.id)} onClick={event => event.stopPropagation()} /></td>}{columns.map(column => <td key={column.id} className="px-3 py-2 text-text">{column.cell(row)}</td>)}</tr>)}</tbody></table></div>
}

export function ShaderBackground({ colors, className }: { colors?: string[]; className?: string }) {
  return <div className={cn("overflow-hidden bg-panel", className)}><MeshGradient colors={colors ?? ["var(--sb-brand)", "var(--sb-blue)", "var(--sb-canvas)"]} style={{ width: "100%", height: "100%" }} /></div>
}

export function CylinderCarousel({ items, value = 0, onValueChange, className }: { items: ReadonlyArray<ReactNode>; value?: number; onValueChange?: (index: number) => void; className?: string }) {
  return <div role="listbox" tabIndex={0} onKeyDown={event => { if (event.key === "ArrowRight") onValueChange?.(Math.min(items.length - 1, value + 1)); if (event.key === "ArrowLeft") onValueChange?.(Math.max(0, value - 1)) }} className={cn("flex items-center justify-center gap-2 overflow-hidden py-4 outline-none", className)}>{items.map((item,index) => { const distance = index - value; return <m.button type="button" role="option" aria-selected={index === value} key={index} onClick={() => onValueChange?.(index)} animate={{ x: distance * 20, scale: Math.max(.65, 1 - Math.abs(distance) * .14), opacity: Math.max(.3, 1 - Math.abs(distance) * .2), rotateY: distance * -18, zIndex: items.length - Math.abs(distance) }} transition={SPRING} className="flex min-h-24 min-w-32 items-center justify-center rounded-xl border border-line bg-panel p-3 text-text shadow-lg">{item}</m.button>})}</div>
}
