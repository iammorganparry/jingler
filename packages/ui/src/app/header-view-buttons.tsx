import type { LucideIcon } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Tooltip } from "../components/tooltip.js"
import { cn } from "../lib/cn.js"

/** One launchable view: a header button or an overflow-menu row. */
export interface HeaderViewItem {
  /** Header view id: a built-in id (`changes`, `checks`, …) or a plugin `<pluginId>.<local>` id. */
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  /** Badge text on one line, e.g. `12` or `3/4`. Absent when there is nothing to count. */
  readonly count?: string
  /** `formatShortcut` input shown in the tooltip, e.g. `mod+shift+d`. */
  readonly shortcut?: string
  /** True for plugin-contributed views; the overflow menu lists them under Plugins. */
  readonly plugin?: boolean
}

/** Pinned view launchers on the right of the workspace header (spec §3c, board 04g). Neutral: the open view is pressed, never blue. */
export function HeaderViewButtons({
  views,
  activeId,
  onOpen,
  className
}: {
  readonly views: ReadonlyArray<HeaderViewItem>
  /** The view open in the focused content group, shown pressed. */
  readonly activeId?: string
  readonly onOpen: (id: string) => void
  readonly className?: string
}) {
  return (
    <div role="group" aria-label="Views" data-testid="header-view-buttons" className={cn("flex items-center gap-0.5", className)}>
      {views.map(({ id, label, icon: Icon, count, shortcut }) => (
        <Tooltip key={id} label={label} shortcut={shortcut} side="bottom">
          <Button
            variant="ghost"
            size="sm"
            data-testid={`header-view-${id}`}
            aria-pressed={activeId === undefined ? undefined : activeId === id}
            onClick={() => onOpen(id)}
            className={cn("h-7 px-2", activeId === id && "bg-text-bright/10 text-text-bright")}
          >
            <Icon size={14} aria-hidden />
            {label}
            {count !== undefined && <Badge tone="count" size="xs">{count}</Badge>}
          </Button>
        </Tooltip>
      ))}
    </div>
  )
}

/** A contextual link in the header: the thing a session produced (its PR, its issue) opens its view. */
export interface HeaderLinkChip {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly onOpen: () => void
}

/** Neutral link chips beside the view launchers (spec §3c "Context links"): `PR #482`, `LIN-482`. */
export function HeaderLinkChips({ chips }: { readonly chips: ReadonlyArray<HeaderLinkChip> }) {
  return (
    <>
      {chips.map((chip) => (
        <Tooltip key={chip.id} label={chip.title} side="bottom">
          <Button
            variant="ghost"
            size="sm"
            data-testid={`header-link-${chip.id}`}
            onClick={chip.onOpen}
            className="h-7 px-2 font-mono text-[11px]"
          >
            {chip.label}
          </Button>
        </Tooltip>
      ))}
    </>
  )
}
