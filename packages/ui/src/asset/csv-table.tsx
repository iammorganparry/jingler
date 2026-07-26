import { useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "../lib/cn.js"
import { parseCsv } from "./csv-parse.js"

const ROW_HEIGHT = 28

/**
 * A CSV/TSV file rendered as a virtualized table: the first parsed row is the
 * header, the rest are body rows.
 *
 * Only the visible rows are mounted — a 50k-row export must not put 50k row
 * elements in the DOM, so the scroll container owns the height and each row is
 * absolutely positioned by the virtualizer. The header is a sibling of the
 * scrolled body (not a row inside it) so `position: sticky` pins it without the
 * virtualizer ever unmounting it.
 */
export function CsvTable({ text, className }: { text: string; className?: string }) {
  const rows = useMemo(() => parseCsv(text), [text])
  const scrollRef = useRef<HTMLDivElement>(null)

  const header = rows[0] ?? []
  // Body rows are addressed as `rows[i + 1]` rather than sliced off into a new
  // array — for a 25 MB file that slice would be a second copy of every row.
  const bodyCount = Math.max(rows.length - 1, 0)

  // One grid template shared by the header and every body row so their columns
  // line up. A leading fixed track holds the row number; each data column gets a
  // 6rem floor so a wide file scrolls horizontally instead of crushing columns
  // to nothing.
  const gridStyle = useMemo(
    () => ({ gridTemplateColumns: `4rem repeat(${Math.max(header.length, 1)}, minmax(6rem, 1fr))` }),
    [header.length]
  )

  const virtualizer = useVirtualizer({
    count: bodyCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16
  })

  return (
    <div ref={scrollRef} className={cn("h-full overflow-auto bg-canvas font-mono text-[12px]", className)}>
      <div
        className="sticky top-0 z-10 grid border-b border-line bg-sunken text-text-bright"
        style={gridStyle}
      >
        <div className="select-none border-r border-hairline px-2 py-1.5 text-right text-dim">#</div>
        {header.map((cell, col) => (
          // Header cells never reorder or mutate, so their column index is a
          // stable identity.
          <div key={col} className="truncate border-r border-hairline px-2 py-1.5 font-medium">
            {cell}
          </div>
        ))}
      </div>

      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index + 1]!
          return (
            <div
              key={item.index}
              className="absolute inset-x-0 top-0 grid border-b border-hairline text-text-body odd:bg-panel/40"
              style={{ height: item.size, transform: `translateY(${item.start}px)`, ...gridStyle }}
            >
              <div className="select-none border-r border-hairline px-2 py-1.5 text-right tabular-nums text-dim">
                {item.index + 1}
              </div>
              {/* Walk the HEADER's columns, not the row's own cells: a ragged
                  row with fewer cells than the header must still render an empty
                  cell per column rather than collapsing the grid. */}
              {header.map((_, col) => (
                <div key={col} className="truncate border-r border-hairline px-2 py-1.5">
                  {row[col] ?? ""}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
