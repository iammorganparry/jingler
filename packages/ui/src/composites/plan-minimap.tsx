import type { PlanStageExecutionStatus } from "@jingler/core"
import { Check, Circle, MessageSquareText } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface PlanMinimapItem {
  readonly id: string
  readonly title: string
  readonly kind: "title" | "section" | "stage"
  readonly executionStatus?: PlanStageExecutionStatus
  readonly openComments: number
}

export interface PlanMinimapViewport {
  /** Scroll offset as a fraction of the whole document. */
  readonly start: number
  /** Visible height as a fraction of the whole document. */
  readonly size: number
}

const executionTone: Record<PlanStageExecutionStatus, string> = {
  queued: "bg-muted-foreground",
  running: "bg-yellow",
  blocked: "bg-red",
  failed: "bg-red",
  interrupted: "bg-orange",
  completed: "bg-green"
}

export function PlanMinimap({
  items,
  activeId,
  viewport,
  onSelect,
  className
}: {
  items: ReadonlyArray<PlanMinimapItem>
  activeId?: string | null
  viewport?: PlanMinimapViewport
  onSelect?: (id: string) => void
  className?: string
}) {
  if (items.length === 0) return null
  const size = Math.max(0.08, Math.min(1, viewport?.size ?? 1))
  const start = Math.max(0, Math.min(1 - size, viewport?.start ?? 0))
  const top = `${start * 100}%`
  const height = `${size * 100}%`

  return (
    <nav
      aria-label="Plan minimap"
      className={cn(
        "relative w-44 flex-none overflow-hidden border-l border-hairline bg-panel/70 px-2 py-4",
        className
      )}
    >
      <div
        aria-hidden="true"
        data-testid="plan-minimap-viewport"
        className="pointer-events-none absolute inset-x-1 rounded border border-blue/25 bg-blue/5 transition-[top,height] duration-150"
        style={{ top, height }}
      />
      <p className="relative z-10 mb-2 px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-dim">
        On this plan
      </p>
      <ol className="relative z-10 flex flex-col gap-0.5">
        {items.map((item) => {
          const active = activeId === item.id
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={active ? "location" : undefined}
                onClick={() => onSelect?.(item.id)}
                className={cn(
                  "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-surface text-text-bright",
                  item.kind === "stage" ? "pl-3" : "font-semibold"
                )}
              >
                {item.kind === "stage" ? (
                  item.executionStatus === "completed" ? (
                    <Check className="size-3 flex-none text-green" />
                  ) : (
                    <span
                      className={cn(
                        "size-1.5 flex-none rounded-full bg-line-strong",
                        item.executionStatus && executionTone[item.executionStatus]
                      )}
                    />
                  )
                ) : (
                  <Circle className="size-2 flex-none text-line-strong" />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[9.5px] text-muted-foreground group-hover:text-text",
                    active && "text-text-bright"
                  )}
                >
                  {item.title}
                </span>
                {item.openComments > 0 && (
                  <span
                    aria-label={`${item.openComments} open ${item.openComments === 1 ? "comment" : "comments"}`}
                    className="inline-flex flex-none items-center gap-0.5 text-[8.5px] font-semibold text-purple"
                  >
                    <MessageSquareText className="size-2.5" />
                    {item.openComments}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
