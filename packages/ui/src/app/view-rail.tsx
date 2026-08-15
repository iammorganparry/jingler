import { SquareTerminal } from "lucide-react"
import { StatusDot } from "../components/status-dot.js"
import { Tooltip } from "../components/tooltip.js"
import { cn } from "../lib/cn.js"
import type { TabDescriptor, TabKey } from "./tab-contributions.js"

/**
 * The session window's view navigation as a vertical icon rail on its right
 * edge.
 *
 * It replaces the icon cluster that lived inside the horizontal tab bar: on a
 * narrow pane those icons fought the chat titles for the same pixels, and the
 * chat titles are the thing you actually read. A rail spends height — which a
 * session view has plenty of — instead of width, which it does not.
 *
 * A count badge (a PR number, an issue count) renders UNDER its icon rather
 * than over it: overlaying "#187" on a 16px glyph makes both unreadable.
 * Labels ride in quick motion tooltips to the rail's left.
 *
 * The terminal toggle sits at the bottom of the rail, visually separated: the
 * views above swap what the pane SHOWS, while the terminal docks alongside
 * whatever is showing. It lives here because the terminal is bound to the
 * session this rail belongs to, not to the app shell.
 */
export function ViewRail({
  tabs,
  active,
  onChange,
  terminalActive = false,
  onToggleTerminal
}: {
  tabs: ReadonlyArray<TabDescriptor>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Whether this session's terminal dock is open (drives the glyph tint). */
  terminalActive?: boolean
  /** Toggle this session's terminal dock; omitted → no terminal button. */
  onToggleTerminal?: () => void
}) {
  return (
    <div
      data-testid="view-rail"
      className="flex w-10 flex-none flex-col items-center gap-1 border-l border-hairline bg-sunken py-2"
    >
      <div
        data-testid="view-tab-controls"
        className="sb-no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = tab.id === active
          const count = tab.badge?.kind === "count" ? tab.badge.text : null
          const diff =
            tab.badge?.kind === "diff" && tab.badge.added + tab.badge.removed > 0
              ? tab.badge
              : null
          return (
            <Tooltip
              key={tab.id}
              label={count === null ? tab.label : `${tab.label} ${count}`}
              side="left"
            >
              <button
                type="button"
                onClick={() => onChange(tab.id)}
                aria-current={isActive ? "page" : undefined}
                // The plain label, never label+count: every by-name lookup (e2e,
                // screen reader, palette muscle memory) finds the same control
                // by the same name wherever it renders. The count is content.
                aria-label={tab.label}
                className={cn(
                  "relative flex w-8 flex-none flex-col items-center justify-center gap-0.5 rounded-md py-1.5 outline-none transition-colors",
                  isActive
                    ? "bg-surface text-blue"
                    : "text-dim hover:bg-panel hover:text-muted-foreground"
                )}
              >
                <Icon className="size-4" />
                {count !== null && (
                  <span
                    className={cn(
                      "max-w-full truncate font-mono text-[8.5px] leading-none tabular-nums",
                      isActive ? "text-blue" : "text-muted-foreground"
                    )}
                  >
                    {count}
                  </span>
                )}
                {diff !== null && (
                  <span className="absolute right-0.5 top-0.5">
                    <StatusDot tone="bg-green" size={5} />
                  </span>
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>
      {onToggleTerminal && (
        <>
          <div aria-hidden className="h-px w-5 flex-none bg-hairline" />
          <Tooltip
            label={`${terminalActive ? "Hide" : "Show"} Terminal (⌃\`)`}
            side="left"
          >
            <button
              type="button"
              onClick={onToggleTerminal}
              aria-label={terminalActive ? "Hide Terminal" : "Show Terminal"}
              aria-pressed={terminalActive}
              data-testid="view-rail-terminal"
              className={cn(
                "flex size-8 flex-none items-center justify-center rounded-md outline-none transition-colors",
                terminalActive
                  ? "bg-surface text-blue"
                  : "text-dim hover:bg-panel hover:text-muted-foreground"
              )}
            >
              <SquareTerminal className="size-4" />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  )
}
