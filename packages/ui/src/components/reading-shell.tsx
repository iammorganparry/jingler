import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Ellipsis } from "lucide-react"
import type { ReactNode } from "react"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { cn } from "../lib/cn.js"
import { Button } from "./button.js"
import { Tooltip } from "./tooltip.js"

export const menuItemClass =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"

export interface ReadingMenuItem {
  label: string
  onSelect: () => void
  /** Failed-coloured text; the caller owns any confirmation. */
  destructive?: boolean
  disabled?: boolean
}

/** The `⋯` button of a reading header and its menu. Renders nothing when there are no items. */
export function ReadingActionsMenu({ items }: { items: ReadonlyArray<ReadingMenuItem> }) {
  if (items.length === 0) return null
  return (
    <DropdownMenu.Root>
      <Tooltip label="More actions" side="bottom">
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions" className="size-7">
            <Ellipsis size={16} aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 flex min-w-[180px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={cn(menuItemClass, item.destructive && "text-state-failed")}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export interface ReadingShellProps {
  title: ReactNode
  /** Grey suffix after the title: `#482`. */
  identifier?: string
  /** Inline after the identifier (a Draft badge). */
  titleAdornment?: ReactNode
  /** The one-line meta row beneath the title. */
  meta?: ReactNode
  /** Right-aligned header actions: buttons, then `ReadingActionsMenu`. */
  actions?: ReactNode
  /** The 280px right rail; stacks under the column below the `wide` tier. */
  rail?: ReactNode
  children?: ReactNode
}

/**
 * The shared PR / issue reading surface: header (title + grey identifier, meta
 * line, actions), a 720px centred column and an optional 280px rail. The
 * scrollbar gutter is reserved on both edges so the column stays on the true
 * centre axis.
 */
export function ReadingShell({ title, identifier, titleAdornment, meta, actions, rail, children }: ReadingShellProps) {
  const docked = atLeast(useWidthTier(), "wide")
  const side = Boolean(rail) && docked
  return (
    <div
      data-testid="reading-shell"
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-editor px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]"
    >
      <div className={cn("mx-auto flex w-full flex-1 gap-8", side ? "max-w-[1032px]" : "max-w-[720px] flex-col")}>
        <div data-testid="reading-column" className="flex min-w-0 max-w-[720px] flex-1 flex-col gap-[18px]">
          <header data-testid="reading-header" className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <h2 className="min-w-0 flex-1 text-pretty text-[20px] font-bold tracking-[-0.2px] text-text-bright">
                {title}
                {identifier && <> <span className="font-normal text-dim">{identifier}</span></>}
                {titleAdornment}
              </h2>
              {actions}
            </div>
            {meta}
          </header>
          {children}
        </div>
        {rail && (
          <aside data-testid="reading-rail" className={cn("flex shrink-0 flex-col gap-4", side ? "w-[280px]" : "w-full")}>
            {rail}
          </aside>
        )}
      </div>
    </div>
  )
}
