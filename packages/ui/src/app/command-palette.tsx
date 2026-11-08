import { useCallback, useEffect, useMemo, useState } from "react"
import { normalizeConversationQuery, type ConversationSearchHit } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { ChevronRight, File, GitBranch, MessageSquare, type LucideIcon, Plug, Zap } from "lucide-react"
import type { ConversationSearchLoader } from "./conversation-search-machine.js"
import { useConversationSearch } from "./use-conversation-search.js"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "../components/command.js"
import { Kbd } from "../components/kbd.js"
import { StatusDot } from "../components/status-dot.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { Badge } from "../components/badge.js"
import { HighlightMatch } from "../components/highlight-match.js"
import { commandPaletteMachine } from "./command-palette-machine.js"
import {
  groupPaletteItems,
  itemKeywords,
  itemsInScope,
  prefixChipFor,
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
const conversationResultValue = (hit: ConversationSearchHit) => `message:${hit.chatId}:${hit.before}:${hit.messageIndex}`

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder = PALETTE_PLACEHOLDER,
  emptyMessage,
  testId = "command-palette",
  showScopes = true,
  searchConversations,
  onOpenConversation
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ReadonlyArray<PaletteItem>
  placeholder?: string
  emptyMessage?: string
  testId?: string
  /** The Workspace · Chat switch and its Tab shortcut. Off for single-purpose pickers. */
  showScopes?: boolean
  searchConversations?: ConversationSearchLoader
  onOpenConversation?: (hit: ConversationSearchHit, query: string) => void
}) {
  const [state, send] = useMachine(commandPaletteMachine)
  const [selectedValue, setSelectedValue] = useState("")
  const { query, scope, prefixActive } = state.context
  const chip = prefixChipFor(scope)
  const conversationSearch = useConversationSearch(open, query, scope, onOpenConversation ? searchConversations : undefined)

  // The query is per-OPENING, not persistent. Reopening onto the last search is
  // the palette answering a question you asked a minute ago — and worse, the
  // first keystroke then appends to it rather than starting a new search.
  useEffect(() => {
    if (!open) send({ type: "RESET" })
  }, [open, send])

  // cmdk mounts every item it is given and re-scores them all on each keystroke.
  // That is fine for a handful of commands but not for a repo's file list, where
  // thousands of mounted rows make the palette crawl. So we score in JS (cheap)
  // and mount only the best matches (the DOM is the expensive part). Small lists
  // fall under the cap and render exactly as before.
  const groups = useMemo(() => {
    const search = query.trim()
    const scoped = itemsInScope(items, scope)
    if (search.length === 0) {
      return groupPaletteItems(
        scoped.length > MAX_RENDERED_ITEMS ? scoped.slice(0, MAX_RENDERED_ITEMS) : scoped
      )
    }
    const ranked = scoped
      .map((item) => ({ item, score: scoreItem(item.id, search, [...itemKeywords(item)]) }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RENDERED_ITEMS)
      .map((scored) => scored.item)
    return groupPaletteItems(ranked)
  }, [items, query, scope])

  // Async results can remove cmdk's selected row without changing its query.
  // Preserve a surviving selection; otherwise make Enter open the first result.
  const selectableValues = useMemo(() => [
    ...groups.flatMap((group) => group.items.map((item) => item.id)),
    ...conversationSearch.hits.map(conversationResultValue)
  ], [groups, conversationSearch.hits])
  useEffect(() => {
    setSelectedValue((current) => selectableValues.includes(current) ? current : selectableValues[0] ?? "")
  }, [selectableValues])

  /**
   * Close FIRST, then run.
   *
   * Several of these actions open something of their own — Settings, the New
   * Session dialog. Running before the palette unmounts would render that
   * behind a live Radix dialog, which still owns the focus trap: the thing you
   * asked for is on screen and cannot be typed into.
   */
  const choose = useCallback(
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
      value={selectedValue}
      onValueChange={setSelectedValue}
      description={searchConversations ? "Search workspaces, commands, and saved conversation text." : undefined}
      // cmdk's ranking, our scoring — one implementation rather than a list we
      // scored and a list cmdk rendered, which can disagree.
      filter={scoreItem}
      data-testid={testId}
      onKeyDown={(event) => {
        if (!showScopes || event.key !== "Tab" || event.shiftKey) return
        event.preventDefault()
        send({ type: "CYCLE_SCOPE" })
      }}
    >
      <CommandInput
        placeholder={chip ? `Search ${chip.label.toLowerCase()}…` : placeholder}
        value={query}
        onValueChange={(value) => send({ type: "QUERY_CHANGED", value })}
        onKeyDown={(event) => {
          if (event.key !== "Backspace" || query.length > 0) return
          send({ type: "BACKSPACE_EMPTY" })
        }}
        prefixChip={
          chip ? (
            <span data-testid="palette-prefix-chip">
              <Badge tone="blue" size="sm">
                {chip.prefix} {chip.label}
              </Badge>
            </span>
          ) : undefined
        }
      />
      {showScopes && !prefixActive && (
        <div className="px-2 pt-2">
          <SegmentedControl
            aria-label="Palette scope"
            size="sm"
            fullWidth
            value={scope}
            onChange={(next) => send({ type: "SET_SCOPE", scope: next })}
            items={[
              { value: "workspace", label: "Workspace" },
              { value: "chat", label: "Chat" }
            ]}
          />
        </div>
      )}
      <CommandList>
        <CommandEmpty>{emptyMessage ?? (conversationSearch.enabled ? "No matching commands or saved conversations" : "No matching commands")}</CommandEmpty>
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
                  {item.status && (
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <StatusDot tone="bg-line-strong" size={6} />
                      {item.status}
                    </span>
                  )}
                  {item.hint && <Kbd className="ml-auto">{item.hint}</Kbd>}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
        <ConversationResults search={conversationSearch} query={normalizeConversationQuery(query)} onOpen={(hit) => { onOpenChange(false); onOpenConversation?.(hit, normalizeConversationQuery(query)) }} />
      </CommandList>
      <div className="flex h-8 items-center gap-4 border-t border-line px-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
        {showScopes && <span className="flex items-center gap-1.5"><Kbd>Tab</Kbd> scope</span>}
      </div>
    </CommandDialog>
  )
}


function ConversationResults({ search, query, onOpen }: {
  search: ReturnType<typeof useConversationSearch>
  query: string
  onOpen: (hit: ConversationSearchHit) => void
}) {
  if (!search.searching && !search.failed && search.hits.length === 0) return null
  return <CommandGroup heading="Saved conversations">
    {search.searching && <CommandItem disabled value="conversation-search-loading" keywords={[query]}>Searching conversations…</CommandItem>}
    {search.failed && <CommandItem disabled value="conversation-search-error" keywords={[query]}>Conversation search unavailable. Try again.</CommandItem>}
    {search.hits.map((hit) => {
      const key = conversationResultValue(hit)
      return <CommandItem key={key} value={key} keywords={[query]} data-testid="conversation-search-hit" onSelect={() => onOpen(hit)}>
        <MessageSquare size={14} className="shrink-0 text-dim" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{hit.sessionTitle} · {hit.chatTitle}</span>
          <span className="block truncate text-[12px] text-muted-foreground"><HighlightMatch text={hit.snippet} query={query} /></span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{hit.role === "user" ? "You" : "Assistant"}</span>
      </CommandItem>
    })}
    {search.hasMore && <CommandItem disabled value="conversation-search-limit" keywords={[query]}>Showing {search.hits.length} matches. Refine your search for more.</CommandItem>}
  </CommandGroup>
}
