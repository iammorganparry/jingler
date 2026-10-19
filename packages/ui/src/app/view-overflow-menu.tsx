import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { HEADER_VIEWS_MAX } from "@jingler/core"
import { Check, ChevronDown, ChevronUp, Ellipsis } from "lucide-react"
import { Button } from "../components/button.js"
import { Tooltip } from "../components/tooltip.js"
import { cn } from "../lib/cn.js"
import { moveHeaderView } from "../lib/header-views.js"
import type { HeaderViewItem } from "./header-view-buttons.js"

const itemClass =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"

const FULL_LABEL = `Header is full (${HEADER_VIEWS_MAX} pinned). Unpin a view first.`

function Section({ title, views, ...rest }: { title: string; views: ReadonlyArray<HeaderViewItem> } & RowProps) {
  if (views.length === 0) return null
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className="px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide text-dim">{title}</DropdownMenu.Label>
      {views.map((view) => <Row key={view.id} view={view} {...rest} />)}
    </DropdownMenu.Group>
  )
}

interface RowProps {
  readonly pinned: ReadonlyArray<string>
  readonly onOpen: (id: string) => void
  readonly onPinnedChange: (ids: ReadonlyArray<string>) => void
}

function Row({ view, pinned, onOpen, onPinnedChange }: { view: HeaderViewItem } & RowProps) {
  const Icon = view.icon
  const isPinned = pinned.includes(view.id)
  const refused = !isPinned && pinned.length >= HEADER_VIEWS_MAX
  const pin = (
    <DropdownMenu.CheckboxItem
      checked={isPinned}
      aria-disabled={refused || undefined}
      aria-label={`Pin ${view.label} to header`}
      data-testid={`pin-${view.id}`}
      // A refused pin stays focusable so its tooltip can explain why nothing happened.
      onSelect={(event) => {
        event.preventDefault()
        if (refused) return
        onPinnedChange(isPinned ? pinned.filter((id) => id !== view.id) : [...pinned, view.id])
      }}
      className={cn(itemClass, "flex-none gap-1.5 text-[11.5px]", refused && "opacity-50")}
    >
      <span className="flex size-3 items-center justify-center">
        <DropdownMenu.ItemIndicator><Check size={12} aria-hidden /></DropdownMenu.ItemIndicator>
      </span>
      Pin to header
    </DropdownMenu.CheckboxItem>
  )
  const moveButton = (direction: "up" | "down") => (
    <button
      type="button"
      aria-label={`Move ${view.label} ${direction}`}
      data-testid={`move-${view.id}-${direction}`}
      onClick={(event) => {
        event.preventDefault()
        onPinnedChange(moveHeaderView(pinned, view.id, direction))
      }}
      className="flex size-5 flex-none items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright disabled:pointer-events-none disabled:opacity-30"
      disabled={direction === "up" ? pinned.indexOf(view.id) === 0 : pinned.indexOf(view.id) === pinned.length - 1}
    >
      {direction === "up" ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
    </button>
  )
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu.Item data-testid={`open-${view.id}`} onSelect={() => onOpen(view.id)} className={cn(itemClass, "flex-1")}>
        <Icon size={14} className="flex-none text-muted-foreground" aria-hidden />
        <span className="flex-1 whitespace-nowrap">{view.label}</span>
      </DropdownMenu.Item>
      {isPinned && (
        <div className="flex flex-none items-center gap-0.5">
          {moveButton("up")}
          {moveButton("down")}
        </div>
      )}
      {refused ? <Tooltip label={FULL_LABEL} side="left">{pin}</Tooltip> : pin}
    </div>
  )
}

/** The `⋯` menu after the pinned header buttons: every view and plugin, each with a "Pin to header" toggle. Spec §3c, board 04g. */
export function ViewOverflowMenu({
  views,
  pinned,
  onOpen,
  onPinnedChange
}: {
  /** Every available view; built-ins first, plugin views flagged with `plugin`. */
  readonly views: ReadonlyArray<HeaderViewItem>
  /** Pinned view ids, in header order. At most {@link HEADER_VIEWS_MAX} can be pinned. */
  readonly pinned: ReadonlyArray<string>
} & Omit<RowProps, "pinned">) {
  const rest = { pinned, onOpen, onPinnedChange }
  return (
    <DropdownMenu.Root>
      <Tooltip label="More views" side="bottom">
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="More views" data-testid="view-overflow-trigger" className="size-7">
            <Ellipsis size={16} aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          data-testid="view-overflow-menu"
          className="z-50 flex min-w-[260px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          <Section title="Views" views={views.filter((view) => !view.plugin)} {...rest} />
          <Section title="Plugins" views={views.filter((view) => view.plugin)} {...rest} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
