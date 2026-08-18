import { ChevronDown, Layers3 } from "lucide-react"
import type { ReactNode } from "react"
import { ChipMenu, type ChipOption } from "../components/chip-menu.js"
import { cn } from "../lib/cn.js"

/** Provider-owned identity and display text for one linked issue. */
export interface LinkedIssueSelectorItem {
  /** Opaque value emitted to the caller. It only needs to be unique in this menu. */
  readonly value: string
  /** Human-facing provider identifier, for example `ENG-123` or `#42`. */
  readonly identifier: string
  readonly title: string
}

export interface LinkedIssueSelectorProps {
  readonly items: ReadonlyArray<LinkedIssueSelectorItem>
  readonly value: string
  readonly onValueChange?: (value: string) => void
  /** Optional provider mark displayed before the current issue. */
  readonly icon?: ReactNode
  /** Compact keeps the closed control to the identifier; full also shows its title. */
  readonly variant?: "compact" | "full"
  readonly disabled?: boolean
  readonly ariaLabel?: string
  readonly className?: string
}

const triggerLabel = (label: string, item: LinkedIssueSelectorItem): string =>
  `${label}, current ${item.identifier}: ${item.title}`

/**
 * A provider-neutral flyout for switching the issue shown by an issue surface.
 *
 * The caller owns selection and provider data. The component only folds an
 * ordered set of opaque values into a keyboard-accessible command menu.
 */
export function LinkedIssueSelector({
  items,
  value,
  onValueChange,
  icon,
  variant = "full",
  disabled = false,
  ariaLabel = "Select linked issue",
  className
}: LinkedIssueSelectorProps) {
  if (items.length === 0) return null
  const current = items.find((item) => item.value === value) ?? items[0]!
  const options: ReadonlyArray<ChipOption<string>> = items.map((item) => ({
    value: item.value,
    label: item.identifier,
    description: item.title,
    ariaLabel: `${item.identifier} ${item.title}`,
    searchText: `${item.identifier} ${item.title}`
  }))
  const interactive = !disabled && items.length > 1

  const control = (
    <span
      data-testid="linked-issue-selector-control"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-2 text-left",
        interactive && "transition-colors hover:border-line-strong hover:bg-surface",
        !interactive && "cursor-default",
        className
      )}
    >
      <span className="flex-none text-muted-foreground">{icon ?? <Layers3 size={14} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] font-medium text-blue">
          {current.identifier}
        </span>
        {variant === "full" && (
          <span className="block truncate text-[12px] text-text-bright" title={current.title}>
            {current.title}
          </span>
        )}
      </span>
      {interactive && (
        <span className="flex flex-none items-center gap-1 text-[10.5px] text-dim">
          <span className="tabular-nums">{items.length}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      )}
    </span>
  )

  if (!interactive) {
    return (
      <div aria-label={`Linked issue ${current.identifier}: ${current.title}`} className="min-w-0">
        {control}
      </div>
    )
  }

  return (
    <ChipMenu
      value={current.value}
      options={options}
      onSelect={onValueChange}
      searchable={items.length > 5}
      searchPlaceholder="Search linked issues…"
      emptyLabel="No linked issues match"
      side="bottom"
      matchTriggerWidth
      ariaLabel={triggerLabel(ariaLabel, current)}
      className="w-full"
      trigger={() => control}
    />
  )
}
