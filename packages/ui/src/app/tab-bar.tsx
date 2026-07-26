import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileDiff,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  type LucideIcon,
  MessagesSquare,
  MoreHorizontal,
  PanelRight,
  Waypoints,
  Workflow,
  X
} from "lucide-react"
import type { ReactNode } from "react"
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
  onToggleBrowser,
  browserActive,
  onMovePaneLeft,
  onMovePaneRight
}: {
  onToggleSplit?: () => void
  splitActive: boolean
  onToggleBrowser?: () => void
  browserActive: boolean
  onMovePaneLeft?: () => void
  onMovePaneRight?: () => void
}) {
  const items: Array<{ label: string; icon: LucideIcon; active?: boolean; onSelect: () => void }> = []
  if (onToggleSplit)
    items.push({ label: "Split plan beside conversation", icon: PanelRight, active: splitActive, onSelect: onToggleSplit })
  if (onToggleBrowser)
    items.push({ label: "Browser preview", icon: Globe, active: browserActive, onSelect: onToggleBrowser })
  if (onMovePaneLeft) items.push({ label: "Move pane left", icon: ChevronLeft, onSelect: onMovePaneLeft })
  if (onMovePaneRight) items.push({ label: "Move pane right", icon: ChevronRight, onSelect: onMovePaneRight })

  // Nothing to collapse — render nothing rather than a button that opens onto an
  // empty menu. A single-pane group with no plan and no browser hits this.
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
 * 1. **There is no Conversation tab.** The session chip IS it. The chip was
 *    already a permanent, unclickable label sitting beside a tab that meant
 *    "show me this session" — two controls for one idea, one of them dead. Merged,
 *    it buys back the chip's width and drops the tab count by one. `TabKey` still
 *    carries `"conversation"`, because every caller, machine and test names the
 *    view that way; only its rendering moved.
 * 2. **The chat pills share this row** (`chatSlot`), behind a divider. So a pane
 *    mid-turn is two rows — this one and the sub-agent rail — where it used to
 *    be three.
 *
 * The non-conversation tabs are glyph-first: their labels only appear when
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
  chatSlot,
  onToggleBrowser,
  browserActive = false,
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
   * The session's name, shown on the conversation chip. Distinct from
   * `pane.title` (which is the same string, but only supplied in a split): the
   * chip is now a TAB, and a tab that renders as an empty pill in a group of one
   * is not a tab. Falls back to the pane title, then to a generic label.
   */
  sessionTitle?: string
  /**
   * The chat pills, rendered inside this row behind a divider. A `ReactNode`
   * rather than data because chat state lives in the desktop renderer (rpc calls
   * + live per-chat activity) and hoisting it into `@starbase/ui` to draw three
   * pills would drag the RPC client into the component library.
   */
  chatSlot?: ReactNode
  /** Toggle the embedded browser preview pane (desktop only; absent in stories). */
  onToggleBrowser?: () => void
  /** Whether the browser preview pane is currently open (highlights the toggle). */
  browserActive?: boolean
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
  const conversationActive = active === "conversation"
  // `"conversation"` is still special — the redesign folded it into the session
  // chip rather than giving it a pill — but it is matched by id on a descriptor
  // now, not by a member of a closed union.
  const conversationTab = tabs.find((tab) => tab.id === "conversation")
  const hasConversation = conversationTab !== undefined
  // Its accessible name comes from the descriptor rather than a local constant,
  // so it cannot drift from `BUILTIN_TAB_META`.
  const conversationLabel = conversationTab?.label ?? "Conversation"
  const viewTabs = tabs.filter((tab) => tab.id !== "conversation")

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
          The conversation tab, wearing the session's name. `data-testid` is kept
          as `pane-chip-N` where a pane index exists, so the split's "which pane
          am I looking at" tests keep pointing at the thing that answers it.
        */}
        {hasConversation && (
          <button
            type="button"
            onClick={() => onChange("conversation")}
            aria-current={conversationActive ? "page" : undefined}
            aria-label={conversationLabel}
            data-testid={pane ? `pane-chip-${pane.index}` : "conversation-tab"}
            title={
              pane
                ? `Pane ${pane.index + 1} — ${title} (⌃⇧${pane.index + 1})`
                : `${conversationLabel} — ${title}`
            }
            className={cn(
              "flex flex-none items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] outline-none transition-colors",
              conversationActive
                ? "bg-surface font-medium text-text-bright"
                : "text-muted-foreground hover:bg-panel hover:text-text",
              // Dimmed when the pane isn't the focused one, so the chips answer
              // "which is which" and "which is listening" with one glance rather
              // than competing with the focus ring for the second question.
              //
              // Applied even when this tab is SELECTED — and last, so it wins the
              // merge. Every pane's conversation tab is selected most of the time,
              // so gating the dim on "not selected" would mean the focus signal
              // was absent in exactly the case it exists for.
              pane && !pane.focused && "text-dim"
            )}
          >
            {pane ? (
              <Badge tone={pane.focused ? "blue" : "count"} size="xs">
                {pane.index + 1}
              </Badge>
            ) : (
              <MessagesSquare
                className={cn("size-3.5 flex-none", conversationActive ? "text-blue" : "text-dim")}
              />
            )}
            {titleWidth ? (
              <span className={cn("truncate", titleWidth)}>{title}</span>
            ) : (
              // No room for a name — but the session still has a state worth
              // showing, and the dot is the same vocabulary the sidebar uses.
              // The tone is looked up, never interpolated: Tailwind scans source
              // text, so a built `bg-${tone}` class is one that never got built.
              status && <StatusDot tone={DOT_TONE[status.tone]} pulse size={7} />
            )}
          </button>
        )}

        {viewTabs.map((tab) => {
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
              // The name has to survive the label being hidden — this is what a
              // screen reader and `getByRole("tab", { name })` read once the
              // text is gone, and it doubles as the hover tooltip.
              aria-label={tab.label}
              title={tab.label}
              className={cn(
                "group flex flex-none items-center gap-1.5 rounded-md py-1 text-[12.5px] outline-none transition-colors",
                // Glyph-only pills lose the label's optical weight, so the
                // horizontal padding tightens with it rather than leaving each
                // glyph marooned in a 60px cell.
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
              {/*
                Badges come off the DESCRIPTOR, not from `key === "pr"` /
                `key === "changes"` against dedicated props.

                Both spellings drew the same two pixels; the difference is that
                keying off the id made "a tab this file knows about" a
                precondition for decorating one, which is exactly what a plugin
                cannot satisfy. A contribution supplies its own badge, so a
                plugin can show an unread count without anyone editing this file.
              */}
              {tab.badge?.kind === "count" && (
                <Badge tone="count" size="xs">
                  {tab.badge.text}
                </Badge>
              )}
              {tab.badge?.kind === "diff" &&
                tab.badge.added + tab.badge.removed > 0 &&
                // Below `mid` the counts collapse to one dot: "+681 −0" is four
                // to seven characters of tabular numerals per tab, and at that
                // width they cost a whole chat pill to say something the Changes
                // view says better.
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

        {/*
          The chat pills. The divider is the only rule left inside the row, and it
          earns its keep: left of it you pick WHAT you're looking at, right of it
          WHICH conversation — two different questions that otherwise read as one
          undifferentiated run of pills.
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
      <div className="flex flex-none items-center justify-end gap-1.5 pl-1">
        {status && (
          // The status word is the first thing to go: it's a duplicate of the
          // sidebar row's own indicator, so nothing is lost that isn't on screen
          // a few hundred pixels to the left.
          <span className={cn("flex-none", !atLeast(tier, "mid") && "hidden")}>
            <Pill tone={status.tone} pulse title={status.detail}>
              {status.label}
            </Pill>
          </span>
        )}
        {collapseActions && (
          <PaneActionsMenu
            onToggleSplit={onToggleSplit}
            splitActive={splitActive}
            onToggleBrowser={onToggleBrowser}
            browserActive={browserActive}
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
        {!collapseActions && onToggleBrowser && (
          <button
            type="button"
            onClick={onToggleBrowser}
            aria-label="Browser preview"
            aria-pressed={browserActive}
            data-testid="toggle-browser"
            title="Toggle browser preview (⌃⇧B)"
            className={cn(
              "flex size-6 items-center justify-center rounded transition-colors hover:bg-hairline",
              browserActive ? "text-blue" : "text-dim hover:text-text-bright"
            )}
          >
            <Globe className="size-4" />
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
