import * as React from "react"
import { ChevronRight, File, GitBranch, type LucideIcon, Plug, Zap } from "lucide-react"
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
  plugin: Plug,
  file: File
}

export const PALETTE_PLACEHOLDER = "Jump to a session or run a command…"

/**
 * How many rows the palette mounts at once. cmdk keeps every item in the DOM and
 * re-scores it per keystroke, so an unbounded file list makes it crawl. Beyond a
 * few hundred, more rows do not help a fuzzy search — the best matches sort to
 * the top regardless.
 */
const MAX_RENDERED_ITEMS = 150

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = PALETTE_PLACEHOLDER,
  emptyMessage = "No matching commands",
  testId = "command-palette"
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ReadonlyArray<PaletteItem>
  placeholder?: string
  emptyMessage?: string
  testId?: string
}) {
  const [query, setQuery] = React.useState("")

  // The query is per-OPENING, not persistent. Reopening onto the last search is
  // the palette answering a question you asked a minute ago — and worse, the
  // first keystroke then appends to it rather than starting a new search.
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  // cmdk mounts every item it is given and re-scores them all on each keystroke.
  // That is fine for a handful of commands but not for a repo's file list, where
  // thousands of mounted rows make the palette crawl. So we score in JS (cheap)
  // and mount only the best matches (the DOM is the expensive part). Small lists
  // fall under the cap and render exactly as before.
  const groups = React.useMemo(() => {
    const search = query.trim()
    if (search.length === 0) {
      return groupPaletteItems(
        items.length > MAX_RENDERED_ITEMS ? items.slice(0, MAX_RENDERED_ITEMS) : items
      )
    }
    const ranked = items
      .map((item) => ({ item, score: scoreItem(item.id, search, [...itemKeywords(item)]) }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RENDERED_ITEMS)
      .map((scored) => scored.item)
    return groupPaletteItems(ranked)
  }, [items, query])

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
      data-testid={testId}
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
