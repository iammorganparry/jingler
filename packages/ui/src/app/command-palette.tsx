import * as React from "react"
import { ChevronRight, GitBranch, type LucideIcon, Plug, Zap } from "lucide-react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "../components/command.js"
import {
  groupPaletteItems,
  itemKeywords,
  type PaletteItem,
  type PaletteItemKind,
  scoreItem
} from "./command-palette-model.js"

/**
 * The global command palette.
 *
 * Dumb and controlled, in the same way `CommandMenu` is: the owner holds `open`
 * and hands down a flat list of items, and this renders them. Every decision
 * about WHAT is in the list — which capabilities exist, which tabs the active
 * session can show, whether a plugin contributed anything — belongs to
 * `JinglerApp`, and every decision about ranking belongs to
 * `command-palette-model.ts`. What is left here is composition.
 */

/** The glyph for a row that did not name one. */
const DEFAULT_ICON: Record<PaletteItemKind, LucideIcon> = {
  session: GitBranch,
  action: Zap,
  tab: ChevronRight,
  plugin: Plug
}

export const PALETTE_PLACEHOLDER = "Jump to a session or run a command…"

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = PALETTE_PLACEHOLDER,
  emptyMessage = "No matching commands"
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ReadonlyArray<PaletteItem>
  placeholder?: string
  emptyMessage?: string
}) {
  const [query, setQuery] = React.useState("")

  // The query is per-OPENING, not persistent. Reopening onto the last search is
  // the palette answering a question you asked a minute ago — and worse, the
  // first keystroke then appends to it rather than starting a new search.
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const groups = React.useMemo(() => groupPaletteItems(items), [items])

  /**
   * Close FIRST, then run.
   *
   * Several of these actions open something of their own — Settings, the New
   * Session dialog. Running before the palette unmounts would render that
   * behind a live Radix dialog, which still owns the focus trap: the thing you
   * asked for is on screen and cannot be typed into.
   */
  const choose = React.useCallback(
    (item: PaletteItem) => {
      onOpenChange(false)
      item.run()
    },
    [onOpenChange]
  )

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      // cmdk's ranking, our scoring — one implementation rather than a list we
      // scored and a list cmdk rendered, which can disagree.
      filter={scoreItem}
      data-testid="command-palette"
    >
      <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{emptyMessage}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.name} heading={group.name}>
            {group.items.map((item) => {
              const Icon = item.icon ?? DEFAULT_ICON[item.kind]
              return (
                <CommandItem
                  key={item.id}
                  // The id is the row's identity and is deliberately NOT
                  // searched — see `scoreItem`. The searchable text is keywords.
                  value={item.id}
                  keywords={[...itemKeywords(item)]}
                  onSelect={() => choose(item)}
                  data-testid={`palette-item-${item.id}`}
                >
                  <Icon size={14} className="shrink-0 text-dim" aria-hidden />
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className="truncate text-[12px] text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                  {item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
