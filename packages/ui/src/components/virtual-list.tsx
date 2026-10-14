import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "../lib/cn.js"

const ROW_HEIGHT = 32
const GROUP_HEIGHT = 24
const MAX_HEIGHT = 260
const OVERSCAN = 6

type VirtualRow<T> =
  | { readonly kind: "group"; readonly key: string; readonly label: string }
  | { readonly kind: "item"; readonly key: string; readonly item: T; readonly itemIndex: number }

interface RowModel<T> {
  readonly rows: ReadonlyArray<VirtualRow<T>>
  /** `itemRows[n]` is the row index of the n-th item (group headers skipped). */
  readonly itemRows: ReadonlyArray<number>
  readonly rowIndexByKey: ReadonlyMap<string, number>
}

const filterItems = <T,>(items: ReadonlyArray<T>, query: string, getText: (item: T) => string) => {
  const needle = query.trim().toLowerCase()
  return needle === "" ? items : items.filter((item) => getText(item).toLowerCase().includes(needle))
}

/** Group headers are inserted wherever an item's group differs from the previous item's. */
const buildRows = <T,>(
  items: ReadonlyArray<T>,
  getKey: (item: T) => string,
  getGroup: ((item: T) => string | undefined) | undefined
): RowModel<T> => {
  const rows: Array<VirtualRow<T>> = []
  const itemRows: Array<number> = []
  const rowIndexByKey = new Map<string, number>()
  let group: string | undefined
  for (const item of items) {
    const next = getGroup?.(item)
    if (next !== undefined && next !== group) rows.push({ kind: "group", key: `group:${rows.length}`, label: next })
    group = next
    const key = getKey(item)
    rowIndexByKey.set(key, rows.length)
    itemRows.push(rows.length)
    rows.push({ kind: "item", key, item, itemIndex: itemRows.length - 1 })
  }
  return { rows, itemRows, rowIndexByKey }
}

/** The item index a navigation key moves to, or null for keys the list ignores. */
const stepItem = (key: string, current: number, last: number): number | null => {
  switch (key) {
    case "ArrowDown": return Math.min(current + 1, last)
    case "ArrowUp": return Math.max(current - 1, 0)
    case "Home": return 0
    case "End": return last
    default: return null
  }
}

const stickyLabelAt = <T,>(rows: ReadonlyArray<VirtualRow<T>>, start: number): string | undefined => {
  for (let i = start; i >= 0; i--) {
    const row = rows[i]
    if (row?.kind === "group") return row.label
  }
  return undefined
}

/**
 * The active row is addressed by item key so it survives filtering. When the key
 * is filtered out the first item shows as active but the remembered key is kept,
 * so clearing the query returns to the previous selection.
 */
const useActiveRow = <T,>(
  model: RowModel<T>,
  controlledKey: string | null | undefined,
  onChange: ((key: string) => void) | undefined
) => {
  const [ownKey, setOwnKey] = useState<string | null>(null)
  const requested = controlledKey === undefined ? ownKey : controlledKey
  const activeRow = (requested === null ? undefined : model.rowIndexByKey.get(requested)) ?? model.itemRows[0] ?? -1
  const setActive = useCallback(
    (key: string) => {
      setOwnKey(key)
      onChange?.(key)
    },
    [onChange]
  )
  return { activeRow, setActive }
}

export interface VirtualListRowState {
  readonly active: boolean
}

export interface VirtualListProps<T> {
  readonly items: ReadonlyArray<T>
  readonly getKey: (item: T) => string
  /** Text matched (case-insensitive substring) against `query`. */
  readonly getText: (item: T) => string
  /** Sticky group header label; items must already be ordered by group. */
  readonly getGroup?: (item: T) => string | undefined
  readonly renderRow: (item: T, state: VirtualListRowState) => ReactNode
  readonly onSelect: (item: T) => void
  readonly query?: string
  /** Controlled active item key; omit to let the list track it. */
  readonly activeKey?: string | null
  readonly onActiveKeyChange?: (key: string) => void
  readonly ariaLabel: string
  readonly empty?: ReactNode
  readonly rowHeight?: number
  readonly groupHeight?: number
  readonly maxHeight?: number
  readonly className?: string
}

function VirtualListRow<T>({
  row,
  id,
  start,
  size,
  active,
  renderRow,
  onSelect,
  onActivate
}: {
  readonly row: VirtualRow<T>
  readonly id: string
  readonly start: number
  readonly size: number
  readonly active: boolean
  readonly renderRow: VirtualListProps<T>["renderRow"]
  readonly onSelect: (item: T) => void
  readonly onActivate: (key: string) => void
}) {
  const style = { height: size, transform: `translateY(${start}px)` }
  if (row.kind === "group") {
    return (
      <div role="presentation" className="absolute inset-x-0 top-0 flex items-center bg-panel px-3 text-[10.5px] font-semibold text-dim" style={style}>
        {row.label}
      </div>
    )
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={cn("absolute inset-x-0 top-0 cursor-default", active && "bg-surface")}
      style={style}
      onMouseMove={() => onActivate(row.key)}
      onClick={() => {
        onActivate(row.key)
        onSelect(row.item)
      }}
    >
      {renderRow(row.item, { active })}
    </div>
  )
}

/**
 * Windowed, searchable list for long data sets (skills, files, mentions).
 * Fixed row height (only the visible window mounts, via `@tanstack/react-virtual`),
 * ↑/↓/Home/End move the active row and scroll it into view, Enter selects, and
 * group headers stick to the top while their group is in view.
 *
 * Pass stable `items`/getter references: rows are rebuilt only when they or the
 * query change, so inline lambdas re-filter on every scroll frame.
 */
export function VirtualList<T>({
  items,
  getKey,
  getText,
  getGroup,
  renderRow,
  onSelect,
  query = "",
  activeKey,
  onActiveKeyChange,
  ariaLabel,
  empty = "No matches",
  rowHeight = ROW_HEIGHT,
  groupHeight = GROUP_HEIGHT,
  maxHeight = MAX_HEIGHT,
  className
}: VirtualListProps<T>) {
  const listId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const model = useMemo(
    () => buildRows(filterItems(items, query, getText), getKey, getGroup),
    [items, query, getText, getKey, getGroup]
  )
  const { rows, itemRows } = model
  const { activeRow, setActive } = useActiveRow(model, activeKey, onActiveKeyChange)
  const groupCount = rows.length - itemRows.length

  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === "group" ? groupHeight : rowHeight),
    [rows, groupHeight, rowHeight]
  )
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    // Keep the sticky header from covering the row being scrolled to.
    scrollPaddingStart: groupCount > 0 ? groupHeight : 0
  })
  const { scrollToIndex } = virtualizer
  useEffect(() => {
    if (activeRow >= 0) scrollToIndex(activeRow, { align: "auto" })
  }, [activeRow, scrollToIndex])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = rows[activeRow]
    if (current?.kind !== "item") return
    if (event.key === "Enter") {
      event.preventDefault()
      onSelect(current.item)
      return
    }
    const next = stepItem(event.key, current.itemIndex, itemRows.length - 1)
    if (next === null) return
    event.preventDefault()
    const row = rows[itemRows[next]!]
    if (row) setActive(row.key)
  }

  if (itemRows.length === 0) {
    return <p role="status" className={cn("px-3 py-5 text-center text-[11px] text-muted-foreground", className)}>{empty}</p>
  }

  const height = Math.min(itemRows.length * rowHeight + groupCount * groupHeight, maxHeight)
  const sticky = groupCount > 0 ? stickyLabelAt(rows, virtualizer.range?.startIndex ?? 0) : undefined
  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={activeRow >= 0 ? `${listId}-${activeRow}` : undefined}
      tabIndex={0}
      className={cn("overflow-auto outline-none", className)}
      style={{ height }}
      onKeyDown={onKeyDown}
    >
      {sticky !== undefined && (
        <div
          aria-hidden="true"
          data-testid="virtual-list-sticky-header"
          className="sticky top-0 z-10 flex items-center bg-panel px-3 text-[10.5px] font-semibold text-dim"
          style={{ height: groupHeight, marginBottom: -groupHeight }}
        >
          {sticky}
        </div>
      )}
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => (
          <VirtualListRow
            key={virtual.key}
            row={rows[virtual.index]!}
            id={`${listId}-${virtual.index}`}
            start={virtual.start}
            size={virtual.size}
            active={virtual.index === activeRow}
            renderRow={renderRow}
            onSelect={onSelect}
            onActivate={setActive}
          />
        ))}
      </div>
    </div>
  )
}
