import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileDiff,
  GitCompareArrows,
  GitPullRequest,
  type LucideIcon,
  MessagesSquare,
  MoreHorizontal,
  PanelRight,
  Waypoints,
  Workflow,
  X
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import type { TabDescriptor, TabKey } from "./tab-contributions.js"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier, type WidthTier } from "../hooks/width-tier.js"

// Re-exported because they ARE this component's props vocabulary — a caller
// building a tab bar should not have to know which module the shapes live in.
export type { TabDescriptor, TabKey }
import { Pill } from "../components/pill.js"
import { Badge } from "../components/badge.js"
import { StatusDot } from "../components/status-dot.js"

/** The icon-button styling every control in the right-hand cluster shares. */
const ACTION_CLASS = "flex size-6 flex-none items-center justify-center rounded transition-colors hover:bg-hairline"

/**
 * The pane's own actions, folded into one button.
 *
 * Only reached below the `mid` tier. The labels are IDENTICAL to the inline
 * buttons' `aria-label`s on purpose: a by-name lookup (the e2e suite, a screen
 * reader user, anyone's muscle memory for the command palette) should find the
 * same control by the same name whether it's inline or behind the menu. What
 * changes at narrow widths is where a control sits, never what it's called.
 */
function PaneActionsMenu({
  onToggleSplit,
  splitActive,
  onMovePaneLeft,
  onMovePaneRight
}: {
  onToggleSplit?: () => void
  splitActive: boolean
  onMovePaneLeft?: () => void
  onMovePaneRight?: () => void
}) {
  const items: Array<{ label: string; icon: LucideIcon; active?: boolean; onSelect: () => void }> = []
  if (onToggleSplit)
    items.push({ label: "Split plan beside conversation", icon: PanelRight, active: splitActive, onSelect: onToggleSplit })
  if (onMovePaneLeft) items.push({ label: "Move pane left", icon: ChevronLeft, onSelect: onMovePaneLeft })
  if (onMovePaneRight) items.push({ label: "Move pane right", icon: ChevronRight, onSelect: onMovePaneRight })

  // Nothing to collapse — render nothing rather than a button that opens onto an
  // empty menu. A single-pane group with no plan hits this.
  if (items.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More pane actions"
          data-testid="pane-actions-menu"
          title="More pane actions"
          className={cn(ACTION_CLASS, "text-dim hover:text-text-bright")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          // `collisionPadding` keeps the menu off the window edge, which matters
          // far more here than usual: this only renders when the pane is narrow,
          // which is exactly when the window tends to be narrow too.
          collisionPadding={8}
          className="z-50 flex min-w-[200px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              aria-label={item.label}
              onSelect={item.onSelect}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] outline-none",
                "data-[highlighted]:bg-surface data-[highlighted]:text-text-bright",
                item.active ? "text-blue" : "text-text-body"
              )}
            >
              <item.icon size={13} className="flex-none" />
              <span className="flex-1 truncate">{item.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * How wide the session chip's title may grow, per tier. At `tiny` the title is
 * dropped entirely — the chip keeps its slot badge and its tooltip, which is
 * enough to tell two panes apart when there is no room to read either name.
 */
const TITLE_WIDTH: Record<WidthTier, string | null> = {
  wide: "max-w-[210px]",
  mid: "max-w-[150px]",
  narrow: "max-w-[92px]",
  tiny: null
}

/** Status tone → dot class. Literal on purpose — see the use site. */
const DOT_TONE = { yellow: "bg-yellow", blue: "bg-blue", green: "bg-green" } as const

/*
 * There is deliberately no `LABEL`/`ICON` lookup here.
 *
 * The redesign this file came from keyed both off a closed `TabKey` union, which
 * cannot describe a tab a plugin contributed — the whole point of
 * `TabContribution` is that a plugin's tab is not a second code path. A
 * `TabDescriptor` carries its own label, icon and badge, so the built-ins and the
 * plugin tabs render through the same branch and the union can stay open.
 *
 * `BUILTIN_TAB_META` in `tab-contributions.ts` is where the built-ins' labels and
 * icons now live.
 */

/**
 * The main-pane tab bar — ONE row of pills carrying everything the pane can
 * switch between.
 *
 * It used to be IDE-style: full-height bordered cells, a hairline between every
 * one, the active cell matching the editor surface with a top accent. Stacked
 * above the chat strip (and, mid-turn, the sub-agent rail too) that drew three
 * ruled rows and ~20 vertical rules before a word of transcript — the chrome
 * out-shouting the thing it framed. Two moves fix it:
 *
 * 1. **The session title is identity, not navigation.** A single click leaves
 *    the current view alone; a double-click renames the session. Conversation
 *    remains an explicit view tab, alongside Plan, PR, and Changes.
 * 2. **The chat pills share this row** (`chatSlot`), behind a divider. So a pane
 *    mid-turn is two rows — this one and the sub-agent rail — where it used to
 *    be three.
 *
 * The view tabs are glyph-first: their labels only appear when
 * selected (and only from `mid` up), because the row now has to hold the chat
 * titles too, and a chat title is the thing you actually read to tell two
 * conversations apart. Every glyph keeps its `aria-label` and `title`.
 */
export function TabBar({
  tabs,
  active,
  onChange,
  status,
  pane,
  sessionTitle,
  onRenameTitle,
  chatSlot,
  onToggleSplit,
  splitActive = false,
  onClosePane,
  onMovePaneLeft,
  onMovePaneRight
}: {
  /**
   * Every tab this pane can switch to, in display order, built-ins and plugin
   * contributions alike.
   *
   * A `TabDescriptor` list rather than a `TabKey` list: each descriptor carries
   * its own label, icon and badge, which is what lets a plugin's tab render
   * through this same branch instead of needing a second one.
   */
  tabs: ReadonlyArray<TabDescriptor>
  active: TabKey
  onChange: (key: TabKey) => void
  /**
   * The session's state as ONE of the five reported words ("Thinking",
   * "Running", …) — never the tool or target, which is what the sidebar row
   * shows too. `detail` carries the specifics ("Running npm test -- auth") to
   * the hover title, where they can't grow the pill on every tool call.
   */
  status?: { label: string; tone: "yellow" | "blue" | "green"; detail?: string }
  /**
   * Which session this pane holds, when that is a question worth answering —
   * i.e. only in a split. A tab bar says what you can look at and never said
   * whose; with two transcripts side by side the only way to tell them apart was
   * to read them.
   *
   * `index` is 0-based here and rendered 1-based, matching the sidebar's slot
   * badge and the ⌃⇧1..4 chords — one numbering for a pane, wherever it's named.
   * Omit entirely in a group of one, where the sidebar's selection already says
   * it and a chip would be a label on the only thing on screen.
   */
  pane?: { index: number; title: string; focused: boolean }
  /**
   * The session's name, shown as the pane identity. Distinct from
   * `pane.title` (which is the same string, but only supplied in a split): the
   * title remains visible in a group of one and falls back to the pane title,
   * then to a generic label.
   */
  sessionTitle?: string
  /** Rename the session title. Double-clicking the title enters edit mode. */
  onRenameTitle?: (title: string) => void
  /**
   * The chat pills, rendered inside this row behind a divider. A `ReactNode`
   * rather than data because chat state lives in the desktop renderer (rpc calls
   * + live per-chat activity) and hoisting it into `@jingler/ui` to draw three
   * pills would drag the RPC client into the component library.
   */
  chatSlot?: ReactNode
  /**
   * Open Plan Review beside the transcript. Omitted — and so hidden — unless the
   * split is actually available: the session has a plan AND the conversation tab
   * is the one on screen. A control that does nothing where it sits is worse than
   * no control at all.
   */
  onToggleSplit?: () => void
  /** Whether the plan is currently split beside the conversation. */
  splitActive?: boolean
  /**
   * Close this pane. Shown only in a multi-pane split: in a group of one there
   * is nothing to close back TO, and the control would just be a way to blank the
   * app. Closing a pane never touches the session — its agent keeps running.
   */
  onClosePane?: () => void
  /**
   * Swap this pane with the one on its left (Arc's Move Left, ⌃⇧⌥←). Absent at
   * the left-hand end — a control that can only fail is worse than no control.
   */
  onMovePaneLeft?: () => void
  /** Swap this pane with the one on its right (Move Right, ⌃⇧⌥→). */
  onMovePaneRight?: () => void
}) {
  // The PANE's width, not the window's. A four-way split on a 4K display gives
  // every pane a `narrow` tier; a maximised single pane on a laptop gives
  // `wide`. Keying off the window would get both backwards.
  const tier = useWidthTier()
  // A selected view tab keeps its label from `mid` up. Below that the row is
  // fighting the chat titles for the same pixels, and the chat titles win: the
  // view you're on is also announced by what's rendered beneath the bar, while
  // one chat title looks exactly like another.
  const showActiveLabel = atLeast(tier, "mid")
  // Below `mid`, the pane's own actions fold into one button. Close is exempt
  // (see below): burying the only way out of a pane you can't read is a trap.
  const collapseActions = !atLeast(tier, "mid")
  const titleWidth = TITLE_WIDTH[tier]
  const title = sessionTitle ?? pane?.title ?? "Conversation"
  const canRenameTitle = onRenameTitle !== undefined && titleWidth !== null
  const [titleDraft, setTitleDraft] = useState<string | null>(null)

  useEffect(() => {
    setTitleDraft(null)
  }, [title])

  const beginTitleEdit = () => {
    if (canRenameTitle) setTitleDraft(title)
  }

  const commitTitle = () => {
    const nextTitle = titleDraft?.trim()
    setTitleDraft(null)
    if (nextTitle && nextTitle !== title) onRenameTitle?.(nextTitle)
  }

  return (
    <div
      data-testid="session-tab-bar"
      data-tier={tier}
      className="flex h-10 flex-none items-center gap-1.5 border-b border-hairline bg-sunken px-2"
    >
      {/*
        `min-w-0 flex-1 overflow-x-auto` is the whole fix for this row.

        Without `min-w-0` a flex child's floor is its MIN-CONTENT width, and
        every label here is `whitespace-nowrap`, so the strip's floor was roughly
        970px — in a pane that the split model will happily make 350px. The
        surplus didn't wrap or scroll, it was simply clipped by the pane's
        `overflow-hidden`, taking the right-hand cluster with it. The scrollbar
        is hidden (`sb-no-scrollbar`) because it would eat a third of the row.
      */}
      <div className="sb-no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {/*
          The session title identifies the pane but never changes its view on a
          single click. `data-testid` stays stable for split and command-palette
          coverage that reads the active session name.
        */}
        <div
          aria-label={`Session title: ${title}`}
          data-testid={pane ? `pane-chip-${pane.index}` : "conversation-tab"}
          title={
            pane
              ? `Pane ${pane.index + 1} — ${title} (double-click to rename)`
              : `${title} (double-click to rename)`
          }
          tabIndex={canRenameTitle ? 0 : undefined}
          onDoubleClick={beginTitleEdit}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault()
              beginTitleEdit()
            }
          }}
          className={cn(
            "flex flex-none select-none items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium text-text-bright outline-none",
            canRenameTitle &&
              "cursor-text focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-1 focus-visible:ring-offset-sunken",
            pane && !pane.focused && "text-dim"
          )}
        >
          {pane ? (
            <Badge tone={pane.focused ? "blue" : "count"} size="xs">
              {pane.index + 1}
            </Badge>
          ) : (
            <MessagesSquare className="size-3.5 flex-none text-dim" />
          )}
          {titleWidth ? (
            titleDraft !== null ? (
              <input
                autoFocus
                aria-label="Session title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    event.currentTarget.blur()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    setTitleDraft(null)
                  }
                }}
                className={cn(
                  "min-w-0 bg-transparent text-[12.5px] font-medium text-text-bright outline-none",
                  titleWidth
                )}
              />
            ) : (
              <span className={cn("truncate", titleWidth)}>{title}</span>
            )
          ) : (
            status && <StatusDot tone={DOT_TONE[status.tone]} pulse size={7} />
          )}
        </div>

        {/*
          The divider keeps pane identity separate from its chat choices. View
          navigation lives in the right cluster beside status.
        */}
        {chatSlot && (
          <>
            <div className="mx-1 h-4 w-px flex-none bg-hairline" aria-hidden="true" />
            {chatSlot}
          </>
        )}
      </div>
      {/*
        `flex-none`, not `flex-1`. As `flex-1` with no `min-w-0` this cluster was
        the FIRST thing the browser squeezed when the row overflowed, so close-
        pane and move-pane vanished before a single tab label did — the controls
        you reach for precisely because the pane is too narrow.
      */}
      <div
        data-testid="session-tab-actions"
        className="flex min-w-0 max-w-[60%] flex-none items-center justify-end gap-1.5 pl-1"
      >
        <div
          data-testid="view-tab-controls"
          className="sb-no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const key = tab.id
            const Icon = tab.icon
            const isActive = key === active
            const showLabel = isActive && showActiveLabel
            return (
              <button
                key={key}
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? "page" : undefined}
                aria-label={tab.label}
                title={tab.label}
                className={cn(
                  "group flex flex-none items-center gap-1.5 rounded-md py-1 text-[12.5px] outline-none transition-colors",
                  showLabel ? "px-2.5" : "px-2",
                  isActive
                    ? "bg-surface font-medium text-text-bright"
                    : "text-muted-foreground hover:bg-panel hover:text-text"
                )}
              >
                <Icon
                  className={cn(
                    "size-3.5 flex-none",
                    isActive ? "text-blue" : "text-dim group-hover:text-muted-foreground"
                  )}
                />
                {showLabel && <span className="whitespace-nowrap">{tab.label}</span>}
                {tab.badge?.kind === "count" && (
                  <Badge tone="count" size="xs">
                    {tab.badge.text}
                  </Badge>
                )}
                {tab.badge?.kind === "diff" &&
                  tab.badge.added + tab.badge.removed > 0 &&
                  (atLeast(tier, "mid") ? (
                    <span className="flex items-center gap-1 font-mono text-[10.5px] tabular-nums">
                      <span className="text-green">+{tab.badge.added}</span>
                      <span className="text-red">−{tab.badge.removed}</span>
                    </span>
                  ) : (
                    <StatusDot tone="bg-green" size={5} />
                  ))}
              </button>
            )
          })}
        </div>

        {status && (
          // The status word is the first thing to go: it's a duplicate of the
          // sidebar row's own indicator, so nothing is lost that isn't on screen
          // a few hundred pixels to the left.
          <span
            data-testid="session-status"
            className={cn("flex-none", !atLeast(tier, "mid") && "hidden")}
          >
            <Pill tone={status.tone} pulse title={status.detail}>
              {status.label}
            </Pill>
          </span>
        )}
        {collapseActions && (
          <PaneActionsMenu
            onToggleSplit={onToggleSplit}
            splitActive={splitActive}
            onMovePaneLeft={onMovePaneLeft}
            onMovePaneRight={onMovePaneRight}
          />
        )}
        {!collapseActions && onToggleSplit && (
          <button
            type="button"
            onClick={onToggleSplit}
            aria-label="Split plan beside conversation"
            aria-pressed={splitActive}
            title="Split plan beside conversation"
            className={cn(
              "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
              splitActive ? "text-blue" : "text-dim hover:text-text-bright"
            )}
          >
            <PanelRight className="size-4" />
          </button>
        )}
        {!collapseActions && (onMovePaneLeft || onMovePaneRight) && (
          // Grouped with the close × rather than beside the tabs: these are all
          // operations on the PANE, not on what's inside it.
          <div className="flex flex-none items-center">
            {onMovePaneLeft && (
              <button
                type="button"
                onClick={onMovePaneLeft}
                aria-label="Move pane left"
                data-testid="move-pane-left"
                title="Move pane left (⌃⇧⌥←)"
                className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            {onMovePaneRight && (
              <button
                type="button"
                onClick={onMovePaneRight}
                aria-label="Move pane right"
                data-testid="move-pane-right"
                title="Move pane right (⌃⇧⌥→)"
                className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
              >
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
        )}
        {/* Never collapsed, at any tier. Every other control here has an
            alternative route (a chord, the sidebar, the menu above); closing an
            unreadable pane is the one thing you'd reach for BECAUSE the pane is
            unreadable, so it stays a one-click target all the way down. */}
        {onClosePane && (
          <button
            type="button"
            onClick={onClosePane}
            aria-label="Close pane"
            data-testid="close-pane"
            title="Close pane (the session keeps running)"
            className={cn(ACTION_CLASS, "text-dim hover:text-text-bright")}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
