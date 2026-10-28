import type { ReactNode } from "react"
import { Kbd } from "../components/kbd.js"
import { cn } from "../lib/cn.js"

const HINTS = [
  { keys: "↑↓", label: "navigate" },
  { keys: "↵", label: "select" },
  { keys: "Esc", label: "close" }
] as const

/**
 * Graphite popover shared by the `@` and `/` composer menus: a trigger/query
 * header, the list, and a keyboard footer. With no rows it shows "No matches"
 * for the typed query, or nothing at all while the query is still empty.
 */
export function AutocompleteMenu({
  trigger,
  query,
  empty,
  children,
  className
}: {
  trigger: "@" | "/"
  query: string
  empty: boolean
  children: ReactNode
  className?: string
}) {
  if (empty && query === "") return null
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-panel shadow-2xl", className)}>
      <div className="flex h-8 items-center gap-2 border-b border-line px-3 text-[11px] text-dim">
        <Kbd>{trigger}</Kbd>
        <span className="min-w-0 flex-1 truncate font-mono">{query}</span>
      </div>
      {empty ? (
        <p role="status" className="truncate px-3 py-5 text-center text-[11px] text-muted-foreground">
          No matches for “{query}”
        </p>
      ) : (
        <>
          {children}
          <div className="flex h-7 items-center gap-3 border-t border-line px-3 text-[10.5px] whitespace-nowrap text-dim">
            {HINTS.map(({ keys, label }) => (
              <span key={keys} className="flex items-center gap-1">
                <Kbd>{keys}</Kbd>
                {label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
