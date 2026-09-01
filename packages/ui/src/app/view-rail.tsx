import { type ReactNode, useId } from "react"
import { LayoutGroup } from "motion/react"
import { SquareTerminal } from "lucide-react"
import { ChipMenu } from "../components/chip-menu.js"
import { StatusDot } from "../components/status-dot.js"
import { Tooltip } from "../components/tooltip.js"
import { cn } from "../lib/cn.js"
import { SharedLayoutIndicator } from "../components/beui/overlays.js"
import type { TabDescriptor, TabKey } from "./tab-contributions.js"

export interface ViewRailMenuOption {
  readonly value: string
  readonly label: ReactNode
  readonly description?: string
  readonly ariaLabel?: string
  readonly searchText?: string
}

/** Optional picker shown instead of immediately opening one rail view. */
export interface ViewRailMenu {
  readonly value: string
  readonly options: ReadonlyArray<ViewRailMenuOption>
  readonly ariaLabel: string
  readonly onSelect: (value: string) => void
}

function RailTabControl({
  tab,
  active,
  menuOpen = false
}: {
  readonly tab: TabDescriptor
  readonly active: boolean
  readonly menuOpen?: boolean
}) {
  const Icon = tab.icon
  const count = tab.badge?.kind === "count" ? tab.badge.text : null
  const diff =
    tab.badge?.kind === "diff" && tab.badge.added + tab.badge.removed > 0
      ? tab.badge
      : null
  return (
    <span
      className={cn(
        "relative z-0 flex w-8 flex-none flex-col items-center justify-center gap-0.5 rounded-md py-1.5 outline-none transition-colors",
        active || menuOpen
          ? "text-blue"
          : "text-dim hover:bg-panel hover:text-muted-foreground"
      )}
    >
      {(active || menuOpen) && <SharedLayoutIndicator layoutId="view-rail-active" />}
      <Icon className="relative size-4" />
      {count !== null && (
        <span
          className={cn(
            "max-w-full truncate font-mono text-[8.5px] leading-none tabular-nums",
            active || menuOpen ? "text-blue" : "text-muted-foreground"
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
    </span>
  )
}

/**
 * The session window's view navigation as a vertical icon rail on its right
 * edge. A tab with a menu opens its picker to the left; ordinary tabs switch
 * immediately.
 */
export function ViewRail({
  tabs,
  active,
  onChange,
  menus = {},
  terminalActive = false,
  onToggleTerminal
}: {
  tabs: ReadonlyArray<TabDescriptor>
  active: TabKey
  onChange: (key: TabKey) => void
  /** Optional pickers keyed by tab id. Omit single-option menus to open directly. */
  menus?: Readonly<Record<TabKey, ViewRailMenu | undefined>>
  /** Whether this session's terminal dock is open (drives the glyph tint). */
  terminalActive?: boolean
  /** Toggle this session's terminal dock; omitted → no terminal button. */
  onToggleTerminal?: () => void
}) {
  const layoutId = useId()
  return (
    <LayoutGroup id={layoutId}>
    <div
      data-testid="view-rail"
      className="flex w-10 flex-none flex-col items-center gap-1 border-l border-hairline bg-sunken py-2"
    >
      <div
        data-testid="view-tab-controls"
        className="sb-no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === active
          const count = tab.badge?.kind === "count" ? tab.badge.text : null
          const menu = menus[tab.id]
          const tooltip = count === null ? tab.label : `${tab.label} ${count}`
          if (menu && menu.options.length > 1) {
            return (
              <ChipMenu
                key={tab.id}
                value={menu.value}
                options={menu.options}
                onSelect={(value) => {
                  menu.onSelect(value)
                  onChange(tab.id)
                }}
                searchable={menu.options.length > 6}
                searchPlaceholder={`Search ${tab.label.toLowerCase()}…`}
                side="left"
                ariaLabel={menu.ariaLabel}
                className="p-0"
                trigger={({ open }) => (
                  <Tooltip label={tooltip} side="left">
                    <RailTabControl tab={tab} active={isActive} menuOpen={open} />
                  </Tooltip>
                )}
              />
            )
          }
          return (
            <Tooltip key={tab.id} label={tooltip} side="left">
              <button
                type="button"
                data-testid={`view-tab-${tab.id}`}
                onClick={() => onChange(tab.id)}
                aria-current={isActive ? "page" : undefined}
                aria-label={tab.label}
                className="outline-none"
              >
                <RailTabControl tab={tab} active={isActive} />
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
    </LayoutGroup>
  )
}
