import type { Session, SessionActivity } from "@jingler/core"
import { activityLabel, displayStatusOf, UNTITLED_SESSION } from "@jingler/core"
import { Archive, PinOff, Trash2 } from "lucide-react"
import { ProviderIcon } from "../components/provider-icon.js"
import { StatusDot } from "../components/status-dot.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { cn } from "../lib/cn.js"
import {
  displayStatusLabel,
  displayStatusTone,
  statusTextClass
} from "../tokens.js"

export interface PersistentSessionTileProps {
  session: Session
  /** Live activity wins over the settled session status. */
  activity?: SessionActivity
  active?: boolean
  onSelect?: (id: string) => void
  onUnpersist?: (id: string) => void
  onArchive?: (id: string) => void
  /** Requests the caller's existing confirmation flow. */
  onDelete?: (id: string) => void
  className?: string
}

/**
 * Compact navigation for an active persistent session.
 *
 * The tile carries the same provider/status vocabulary as an ordinary row, but
 * spends its smaller footprint vertically: provider + live dot, then title and
 * the fixed five-word status label. Radix owns the context menu and keyboard
 * focus stays on the native button.
 */
export function PersistentSessionTile({
  session,
  activity,
  active = false,
  onSelect,
  onUnpersist,
  onArchive,
  onDelete,
  className
}: PersistentSessionTileProps) {
  const display = displayStatusOf(activity, session.status)
  const tone = displayStatusTone[display]
  const label = displayStatusLabel[display]
  const detail = activity ? activityLabel(activity) : label
  const name = session.title || UNTITLED_SESSION
  const actions: ContextMenuItem[] = [
    ...(onUnpersist
      ? [{ label: "Unpersist", icon: PinOff, onSelect: () => onUnpersist(session.id) }]
      : []),
    ...(onArchive
      ? [{ label: "Archive", icon: Archive, onSelect: () => onArchive(session.id) }]
      : []),
    ...(onDelete
      ? [
          {
            label: "Delete",
            icon: Trash2,
            tone: "danger" as const,
            separated: true,
            onSelect: () => onDelete(session.id)
          }
        ]
      : [])
  ]

  const tile = (
    <button
      type="button"
      data-testid={`persistent-session-tile-${session.id}`}
      data-status={display}
      aria-label={name}
      aria-current={active ? "page" : undefined}
      title={`${name} · ${detail}`}
      onClick={() => onSelect?.(session.id)}
      className={cn(
        "group flex h-[68px] min-w-0 flex-col rounded-2xl border px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-blue/40 bg-surface"
          : "border-line bg-sunken hover:border-line-strong hover:bg-surface/50",
        className
      )}
    >
      <span className="flex w-full items-center">
        <ProviderIcon
          cli={session.cli}
          size={15}
          mono={!active}
          className={cn(!active && "text-muted-foreground group-hover:text-text")}
        />
        <span className="flex-1" />
        <StatusDot status={tone} size={7} />
      </span>
      <span
        className={cn(
          "mt-1 w-full truncate text-[11.5px]",
          active ? "font-semibold text-text-bright" : "font-medium text-text"
        )}
      >
        {name}
      </span>
      <span
        className={cn("w-full truncate font-mono text-[9.5px]", statusTextClass[tone])}
      >
        {label}
      </span>
    </button>
  )

  return actions.length > 0 ? (
    <ContextMenu items={actions}>{tile}</ContextMenu>
  ) : (
    tile
  )
}
