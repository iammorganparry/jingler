import * as React from "react"
import type { Environment, SessionPrStatus, Session, SessionActivity, SessionDisplayStatus, User } from "@jingler/core"
import { displayStatusOf, persistentOf, UNTITLED_SESSION } from "@jingler/core"
import {
  ChevronRight,
  BrainCircuit,
  Columns2,
  GitBranch,
  Layers,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  Star
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { JinglerMark } from "../brand/jingler-mark.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { ResizeHandle, useResizableWidth } from "../components/resizable.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { FilterMenu } from "../components/filter-menu.js"
import { HoverCard } from "../components/hover-card.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { PersistentSessionTile } from "../composites/persistent-session-tile.js"
import { SessionRow } from "../composites/session-row.js"
import { SessionHoverCard } from "../composites/session-hover-card.js"
import { SplitRow } from "../composites/split-row.js"
import { displayStatusLabel, displayStatusTone } from "../tokens.js"
import { UserMenu } from "../composites/user-menu.js"
import type { SplitGroup } from "./split-layout.js"
import {
  filterSessions,
  groupSessions,
  isNarrowed,
  loadFilters,
  reconcileRepo,
  saveFilters,
  sessionFilterAxes,
  type SessionFilters
} from "./session-filters.js"

export interface SessionSidebarProps {
  sessions: ReadonlyArray<Session>
  environments?: ReadonlyArray<Environment>
  activeSessionId: string | null
  /**
   * Which pane each on-screen session occupies, for the numbered badges. Absent
   * when the split isn't wired (stories) — rows then show no badge.
   */
  slotBySession?: ReadonlyMap<string, number>
  /**
   * The splits, so a multi-pane group renders as ONE row (Arc's pill) rather than
   * as N unrelated rows. Groups of one aren't listed here — a one-pane group and
   * a plain session are the same object, and the caller renders it as a
   * `SessionRow` either way.
   */
  splitGroups?: ReadonlyArray<SplitGroup>
  /** Which group is on screen (highlights its pill). */
  activeGroupId?: string | null
  /** Focus one pane of a split from its sidebar segment. */
  onFocusPane?: (groupId: string, index: number) => void
  /** Close one pane from its segment's × (the session keeps running). */
  onClosePane?: (groupId: string, index: number) => void
  /** Arc's "Separate all tabs" — every pane flies out to its own row. */
  onSeparateAll?: (groupId: string) => void
  /** A session was dropped on a pill, or picked from its "Split with ▸" submenu. */
  onSplitWith?: (groupId: string, sessionId: string, at: number) => void
  onSelect: (id: string) => void
  /** Manually rename a session (double-click its title) — pins the auto-name. */
  onRename?: (id: string, title: string) => void
  /** Promote or demote a session from the persistent tray. */
  onSetPersistent?: (id: string, persistent: boolean) => void
  /** Archive an active session from its row quick-actions (undoable via restore). */
  onArchive?: (id: string) => void | Promise<void>
  /** Restore an archived session from its row quick-actions. */
  onRestore?: (id: string) => void
  /** Permanently delete a session from its row quick-actions (caller confirms). */
  onDelete?: (id: string) => void | Promise<void>
  /** Live per-session agent status, overriding the persisted status. */
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live linked-PR state per session id, badged onto the row (never auto-archives). */
  prStates?: Record<string, SessionPrStatus>
  /** GitHub owner login per session, used for repository avatars. */
  repoOwners?: Readonly<Record<string, string>>
  /** Open the New Session dialog (header "+" / ⌘N). */
  onNewSession?: () => void
  /** The signed-in user, shown in the footer account menu. */
  user?: User
  /** Open the Usage & limits modal (from the account menu). */
  onOpenUsage?: () => void
  /** Open the Settings view (from the account menu). */
  onOpenSettings?: () => void
  /** Sign out (from the account menu). */
  onSignOut?: () => void
  /** Whether GitHub is connected (green dot on the Settings item). */
  ghConnected?: boolean
  /** Repo names that are starred — their groups pin to the top (repo grouping). */
  starredRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's starred state from its header star button. */
  onToggleStar?: (repoName: string) => void | Promise<void>
  /**
   * Repo names whose groups are collapsed — their session lists are hidden.
   * Only applies while Group by is Repository.
   */
  collapsedRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's collapsed state from its header. */
  onToggleCollapsed?: (repoName: string) => void | Promise<void>
  /** App version (from `__APP_VERSION__`), shown in the footer. */
  version?: string
  /** Paid-team memory is a first-class destination, not a session row. */
  memoryEligible?: boolean
  memoryActive?: boolean
  onOpenMemory?: () => void
  /**
   * Open on these filters instead of the persisted ones.
   *
   * For stories and tests, which need a deterministic view and cannot reach the
   * menu (Radix portals its flyouts and needs a real pointer to open one). Not
   * used by the app — there, the persisted set IS the right starting point.
   */
  defaultFilters?: SessionFilters
}

/** Left rail: sessions grouped by repository, with a first-run empty hint. */
/**
 * The sidebar's full contents.
 *
 * Rendered by `SessionSidebar` below either docked in the layout or floating in
 * the hover overlay — the same markup both times, so the expanded rail can't
 * drift out of sync with the docked sidebar it is meant to be.
 */
function SidebarBody({
  width,
  onResize,
  sessions,
  environments = [],
  activeSessionId,
  slotBySession,
  splitGroups,
  activeGroupId,
  onFocusPane,
  onClosePane,
  onSeparateAll,
  onSplitWith,
  onSelect,
  onRename,
  onSetPersistent,
  onArchive,
  onRestore,
  onDelete,
  liveActivity,
  prStates,
  repoOwners,
  onNewSession,
  user,
  onOpenUsage,
  onOpenSettings,
  onSignOut,
  ghConnected = false,
  starredRepoNames,
  onToggleStar,
  collapsedRepoNames,
  onToggleCollapsed,
  version,
  defaultFilters,
  memoryEligible = false,
  memoryActive = false,
  onOpenMemory,
  onCollapse
}: SessionSidebarProps & {
  /** Current docked width in px. */
  width: number
  /** Drag deltas from the edge handle. */
  onResize?: (deltaX: number) => void
  /** Collapse to the icon rail (the header's `PanelLeft` button). */
  onCollapse?: () => void
}) {
  const [filters, setFiltersState] = React.useState<SessionFilters>(
    () => defaultFilters ?? loadFilters()
  )

  const setFilters = React.useCallback((next: SessionFilters) => {
    setFiltersState(next)
    saveFilters(next)
  }, [])

  // A persisted repo filter outlives the sessions that justified it. Left alone
  // it would empty the sidebar with no visible cause — the filter naming the
  // missing repo isn't in the menu either, because the menu is built from the
  // repos that exist.
  React.useEffect(() => {
    const reconciled = reconcileRepo(filters, sessions)
    if (reconciled !== filters) setFilters(reconciled)
  }, [filters, sessions, setFilters])

  // ⌘F is no longer handled here. It used to focus this panel's "Filter
  // sessions…" field; that field is gone and search is global, so the chord now
  // opens the command palette from `jingler-app.tsx` alongside ⌘K. Keeping a
  // second window-level listener here would be two handlers racing for one
  // event — see the comment on that one.

  // The GROUP a session sits in. The row's own five-word rollup, with ONE further
  // fold: thinking → running. An agent flips between thinking and running every
  // few seconds as tools start and stop, so grouping on that distinction would
  // reorder the list under the reader's cursor. The row still says which.
  const statusOf = React.useCallback(
    (s: Session): SessionDisplayStatus => {
      const display = displayStatusOf(liveActivity?.[s.id], s.status)
      return display === "thinking" ? "running" : display
    },
    [liveActivity]
  )

  const filtered = React.useMemo(
    () => filterSessions(sessions, "", filters),
    [sessions, filters]
  )

  // The tray is fixed navigation, independent of the list filters below it.
  // Archived persistent sessions step out until restored, while keeping their
  // flag in storage so restoration puts them straight back here.
  const persistentSessions = React.useMemo(
    () => sessions.filter((session) => persistentOf(session) && !session.archived),
    [sessions]
  )

  /**
   * Sessions that sit inside a SPLIT of two panes or more.
   *
   * Groups of one are deliberately absent: they render as ordinary rows, which
   * is the whole point of the model — a lone pane and a lone session are
   * indistinguishable.
   */
  const splitMemberIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const g of splitGroups ?? []) {
      if (g.panes.length < 2) continue
      for (const p of g.panes) ids.add(p.sessionId)
    }
    return ids
  }, [splitGroups])

  // Sessions that belong to a SPLIT (two panes or more) are held out of the
  // grouped lists entirely — they are drawn once, above, in the splits section.
  // Held out BEFORE grouping rather than skipped during render, so a group's
  // count badge matches the rows under it and a repo whose every session is in
  // a split disappears instead of rendering an empty heading.
  const groups = React.useMemo(
    () =>
      groupSessions(
        filtered.filter(
          (s) => !((persistentOf(s) && !s.archived) || splitMemberIds.has(s.id))
        ),
        filters,
        statusOf,
        starredRepoNames
      ),
    [filtered, splitMemberIds, filters, statusOf, starredRepoNames]
  )

  // Counts for the Status flyout, computed over the SEARCH-narrowed list rather
  // than the whole store: while you're typing, "Archived 3" should mean three
  // matches, not three in existence.
  const searched = React.useMemo(
    () => filterSessions(sessions, "", { ...filters, status: "all", repo: null }),
    [sessions, filters]
  )

  const axes = React.useMemo(
    () => sessionFilterAxes(filters, setFilters, searched),
    [filters, setFilters, searched]
  )

  const narrowed = isNarrowed(filters)

  /**
   * The splits worth drawing, in workspace order.
   *
   * A split used to be drawn INSIDE whichever repo group its first surviving
   * pane happened to sit in. That stopped making sense the moment a split could
   * span two repos: the pill claimed one repo as its home, and the other repo's
   * session had no entry of its own to show. Splits now sit above the groups
   * entirely, so a split belongs to no repo — which is the truth.
   *
   * Kept only while at least one pane survives the current search/filters: a
   * split none of whose sessions match should no more appear than a session that
   * doesn't match. ONE surviving pane is enough — the pill names every member,
   * so hiding it because pane 1 didn't match would lose pane 2's only entry.
   */
  const visibleSplits = React.useMemo(() => {
    const rendered = new Set(filtered.map((s) => s.id))
    return (splitGroups ?? []).filter(
      (g) => g.panes.length >= 2 && g.panes.some((p) => rendered.has(p.sessionId))
    )
  }, [splitGroups, filtered])

  const renderSplit = (split: SplitGroup) => (
    <SplitRow
      key={split.id}
      group={split}
      sessions={sessions}
      liveActivity={liveActivity}
      active={split.id === activeGroupId}
      onFocusPane={onFocusPane}
      onClosePane={onClosePane}
      onSeparateAll={onSeparateAll}
      onSplitWith={onSplitWith}
      onSetPersistent={onSetPersistent}
      splitCandidates={sessions.filter(
        (c) => !(c.archived || split.panes.some((p) => p.sessionId === c.id))
      )}
    />
  )

  /**
   * One row in a grouped list.
   *
   * Split members never reach here — they are held out of `groups` before
   * grouping, so a session cannot appear both in a pill and as a loose row.
   */
  const renderEntry = (s: Session) => {
    return (
      <SessionRow
        key={s.id}
        session={s}
        environment={environments.find((environment) => environment.id === s.environmentId)}
        repoOwner={repoOwners?.[s.id]}
        activity={liveActivity?.[s.id]}
        prState={prStates?.[s.id]}
        active={s.id === activeSessionId}
        slotIndex={slotBySession?.get(s.id) ?? null}
        onSelect={onSelect}
        onRename={onRename}
        onSetPersistent={onSetPersistent}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    )
  }

  return (
    <div
      style={{ width }}
      data-testid="session-sidebar"
      className="relative flex flex-none flex-col overflow-hidden"
    >
      {/* The width was a hard `w-[266px]` with no way to change it — the only
          fixed column in the app that couldn't be dragged. */}
      {onResize && (
        <ResizeHandle
          onResize={onResize}
          aria-label="Resize sidebar"
          className="absolute inset-y-0 right-0 bg-transparent"
        />
      )}
      {/*
        The header — collapse, search, filter and new-session, on ONE row.

        This used to be two rows: a title row reading "⌘ Sessions (4)" above a
        search row. Both went, and neither is missed.

        The title was labelling the only thing this panel has ever contained.
        The count duplicated a list the operator is looking at. And the ⌘ tile
        was a command-palette affordance parked next to a word it had nothing to
        do with — the palette has ⌘K and the title bar, which is where people
        already reach for it.

        What replaced them is the row that was doing the work anyway. The
        reclaimed ~34px is roughly one session row, and it comes back at every
        window height rather than only when the list is long.
      */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        {/*
          The mark's home. It was centred in the title bar until global search
          took that slot, and this is the better corner for it anyway: macOS
          reserves the window's top-left for traffic lights, but the SIDEBAR's
          top-left is below that chrome and collides with nothing on any
          platform. `text-brand` for the same reason it was branded up there —
          it is the one spot of colour in a monochrome column.
        */}
        <JinglerMark className="h-[14px] w-auto flex-none text-brand" />
        {/* The rail's expand button lives in the same corner, so the control
            that changes this state is in one place rather than two. */}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
            className="flex size-7 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeft size={14} />
          </button>
        )}
        {/*
          Where the "Filter sessions…" field used to be.

          Search is global now: it lives in the title bar and is served by the
          command palette, which already indexes every session, every archived
          session and every action. A second field here would be a second search
          implementation over the same index, and the two would drift.

          What stays is the FILTER menu on the right — status, repo, starred.
          Those are not search: they narrow by facet rather than by text, they
          persist, and they are about which sessions belong on screen rather than
          about finding one. The spacer keeps them pinned right.
        */}
        <div className="min-w-0 flex-1" />
        <FilterMenu axes={axes}>
          <button
            type="button"
            aria-label="Filter and sort sessions"
            title="Filter and sort sessions"
            data-testid="session-filter-menu"
            className={cn(
              "relative flex size-7 flex-none items-center justify-center rounded-md outline-none transition-colors",
              "hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
              narrowed ? "text-blue" : "text-dim hover:text-text"
            )}
          >
            <SlidersHorizontal size={14} />
            {/* A dot, because the button's own colour is easy to miss and a
                narrowed list looks exactly like a short one. Only NARROWING
                earns it — grouping and sorting rearrange what's there rather
                than hiding any of it. */}
            {narrowed && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-blue" />
            )}
          </button>
        </FilterMenu>
        {/*
          Icon-only now that it shares a row. The `⌘N` chip that used to sit
          beside it was the widest thing in the old header, and it was teaching
          a shortcut to someone already reaching for the button — the tooltip
          says it instead, which is where a shortcut is normally learnt.
        */}
        <button
          type="button"
          onClick={onNewSession}
          aria-label="New session"
          title="New session (⌘N)"
          // Three buttons in the app answer to the accessible name "New
          // session" — this one, the sidebar's empty-state prompt, and the
          // dialog's own submit. A testid is the only unambiguous handle.
          data-testid="new-session"
          className="flex size-7 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus size={15} />
        </button>
      </div>

      {memoryEligible && (
        <div className="px-2 pb-2">
          <button
            type="button"
            data-testid="memory-sidebar-item"
            aria-current={memoryActive ? "page" : undefined}
            onClick={onOpenMemory}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              memoryActive
                ? "bg-surface text-text-bright"
                : "text-muted-foreground hover:bg-surface/60 hover:text-text"
            )}
          >
            <BrainCircuit size={15} className={memoryActive ? "text-blue" : undefined} />
            <span className="flex-1">Memory</span>
            {memoryActive && <span className="text-[10px] text-blue">Open</span>}
          </button>
        </div>
      )}

      {/* Fixed persistent navigation: never narrowed by the ordinary list's
          status/repo filters, and never duplicated in those groups. */}
      <div
        data-testid="persistent-session-tray"
        className="grid max-h-64 flex-none grid-cols-3 gap-1.5 overflow-y-auto px-3 pb-2"
      >
        {persistentSessions.length > 0 ? (
          persistentSessions.map((session) => (
            <PersistentSessionTile
              key={session.id}
              session={session}
              activity={liveActivity?.[session.id]}
              active={session.id === activeSessionId}
              onSelect={onSelect}
              onUnpersist={
                onSetPersistent
                  ? (id) => onSetPersistent(id, false)
                  : undefined
              }
              onArchive={onArchive}
              onDelete={onDelete}
            />
          ))
        ) : (
          <button
            type="button"
            data-testid="persistent-session-add"
            onClick={onNewSession}
            aria-label="New session"
            title="New session"
            className="flex h-[68px] min-w-0 items-center justify-center rounded-2xl border border-dashed border-line text-dim outline-none transition-colors hover:border-blue hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      {/* Groups (or the empty hint when there are no sessions yet) */}
      <div className="flex flex-1 flex-col overflow-auto px-2 pb-2 pt-0.5">
        {sessions.length === 0 ? (
          <div className="flex flex-1 flex-col px-1">
            <div className="m-auto flex flex-col items-center gap-2.5 px-4 text-center">
              <Layers size={22} className="text-line-strong" />
              <span className="text-[12px] leading-[1.5] text-muted-foreground">
                No sessions yet.
                <br />
                They&apos;ll appear here as you start them.
              </span>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2.5 px-4 text-center">
            <Search size={20} className="text-line-strong" />
            {/*
              Names the FILTERS, not a search term. This panel no longer has a
              text field — search is global and lives in the title bar — so the
              only way to empty a non-empty store is the facet menu beside this
              message. Quoting a search term here would name a control that is
              not on screen, which is worse than saying nothing: the operator
              would go looking for a box to clear.
            */}
            <span className="text-[12px] leading-[1.5] text-muted-foreground">
              No sessions match these filters.
            </span>
          </div>
        ) : (
          <>
          {/* Splits, above every group and directly under the filters.
              A split can span repos, so nesting it under one repo's heading
              named an owner it doesn't have. Its own section says the true
              thing: these are on screen together, wherever they came from. */}
          {visibleSplits.length > 0 && (
            <div>
              <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
                <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
                <Columns2 size={12} className="text-blue" />
                <span className="flex-1 truncate text-[11.5px] font-semibold text-text">
                  {visibleSplits.length === 1 ? "Split" : "Splits"}
                </span>
                <Badge tone="count" size="xs">
                  {visibleSplits.length}
                </Badge>
              </div>
              <div className="mb-1 flex flex-col gap-[3px]">{visibleSplits.map(renderSplit)}</div>
            </div>
          )}
          {groups.map((group) => {
            // A `null` key is the flat list (Group by: None) — rows with no
            // heading over them at all, rather than one heading called
            // "Everything", which would be a header that says nothing.
            if (group.key === null) {
              return (
                <div key="__flat__" className="mb-1 flex flex-col gap-[3px] pt-1">
                  {group.sessions.map(renderEntry)}
                </div>
              )
            }
            const key = group.key
            // Collapse applies to repo grouping only (Status groups stay open).
            const collapsible = filters.groupBy === "repo" && Boolean(onToggleCollapsed)
            const collapsed = collapsible && (collapsedRepoNames?.has(key) ?? false)
            const isStatus = filters.groupBy === "status"
            return (
            <div key={key}>
              <div className="flex items-center gap-[7px] px-1.5 pb-1.5 pt-2.5">
                {collapsible ? (
                  <button
                    type="button"
                    onClick={() => onToggleCollapsed?.(key)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? "Expand repository" : "Collapse repository"}
                    className="flex min-w-0 flex-1 items-center gap-[7px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        "flex-none text-muted-foreground transition-transform",
                        !collapsed && "rotate-90"
                      )}
                    />
                    <GitBranch size={12} className="flex-none text-cyan" />
                    <span className="flex-1 truncate font-mono text-[11.5px] font-semibold text-text">
                      {key}
                    </span>
                  </button>
                ) : (
                  <>
                    <span className="w-2 text-center text-[9px] text-muted-foreground">▾</span>
                    {isStatus ? (
                      <StatusDot status={displayStatusTone[key as SessionDisplayStatus]} size={8} />
                    ) : (
                      <GitBranch size={12} className="text-cyan" />
                    )}
                    <span
                      className={cn(
                        "flex-1 truncate text-[11.5px] font-semibold text-text",
                        isStatus ? "" : "font-mono"
                      )}
                    >
                      {isStatus ? displayStatusLabel[key as SessionDisplayStatus] : key}
                    </span>
                  </>
                )}
                {filters.groupBy === "repo" && onToggleStar && (
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={starredRepoNames?.has(key) ? "Unstar repository" : "Star repository"}
                    aria-pressed={starredRepoNames?.has(key) ?? false}
                    onClick={() => onToggleStar(key)}
                    className={cn(
                      "size-5 rounded hover:bg-surface",
                      starredRepoNames?.has(key) && "text-yellow hover:text-yellow"
                    )}
                  >
                    <Star size={12} className={starredRepoNames?.has(key) ? "fill-current" : undefined} />
                  </Button>
                )}
                <Badge tone="count" size="xs">
                  {group.sessions.length}
                </Badge>
              </div>
              {!collapsed && (
                <div className="mb-1 flex flex-col gap-[3px]">{group.sessions.map(renderEntry)}</div>
              )}
            </div>
            )
          })}
          </>
        )}
      </div>

      {/* Footer: account menu (name / email / avatar → Settings, Usage, Sign out). */}
      <div className="flex-none border-t border-hairline p-1.5">
        {user ? (
          <UserMenu
            user={user}
            onOpenSettings={onOpenSettings}
            onOpenUsage={onOpenUsage}
            onSignOut={onSignOut}
            ghConnected={ghConnected}
            version={version}
          />
        ) : (
          <span
            className="flex h-9 items-center px-2 font-mono text-[11px] text-dim"
            title={version ? "App version" : undefined}
          >
            {version ? `Jingler v${version}` : "Jingler"}
          </span>
        )}
      </div>
    </div>
  )
}

/** Docked width bounds. `initial` is the 266px the sidebar was hard-coded to. */
const SIDEBAR_WIDTH = { storageKey: "sb.sidebar.width", initial: 266, min: 200, max: 380 } as const

/** Below this much room for the whole shell, the sidebar becomes a rail. */
const RAIL_THRESHOLD = 1000

/** The collapsed rail's width — one avatar plus breathing room. */
const RAIL_WIDTH = 52

const PIN_STORAGE_KEY = "sb.sidebar.pinned"

/** How long the pointer must rest on a rail cell before its card opens. */
const HOVER_INTENT_MS = 150

const readPinned = (): boolean | null => {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY)
    return raw === null ? null : raw === "1"
  } catch {
    return null
  }
}

/**
 * The collapsed sidebar: one cell per session, status carried by the dot.
 *
 * Deliberately NOT a scaled-down copy of the full sidebar. Grouping, filtering
 * and the group-by control all need labels to mean anything, so the rail drops
 * them entirely and keeps only the two things that survive at 52px: which
 * sessions exist, and which one you're in. Everything else is one hover away —
 * per CELL, in a `SessionHoverCard`.
 *
 * That per-cell card replaced an earlier design where hovering the rail ANYWHERE
 * floated the entire sidebar back over the content. One hover gesture now means
 * one thing: "tell me about THIS session". Expanding is a deliberate click (or
 * ⌘B), because re-opening the whole sidebar is a layout change and layout
 * changes shouldn't happen to you in passing.
 */
function SessionRail({
  sessions,
  activeSessionId,
  liveActivity,
  prStates,
  onSelect,
  onNewSession,
  memoryEligible,
  memoryActive,
  onOpenMemory,
  onExpand
}: {
  sessions: ReadonlyArray<Session>
  activeSessionId: string | null
  liveActivity?: Record<string, SessionActivity | undefined>
  prStates?: Record<string, SessionPrStatus>
  onSelect?: (id: string) => void
  onNewSession?: () => void
  memoryEligible?: boolean
  memoryActive?: boolean
  onOpenMemory?: () => void
  /** Re-dock the sidebar (the top button). */
  onExpand: () => void
}) {
  const live = sessions.filter((s) => !s.archived)
  const persistent = live.filter(persistentOf)
  const ordinary = live.filter((session) => !persistentOf(session))

  const renderCell = (s: Session) => {
    const active = s.id === activeSessionId
    const status = displayStatusOf(liveActivity?.[s.id], s.status)
    return (
      <HoverCard
        key={s.id}
        delayMs={HOVER_INTENT_MS}
        content={
          <SessionHoverCard
            session={s}
            activity={liveActivity?.[s.id]}
            prState={prStates?.[s.id]}
          />
        }
      >
        <button
          type="button"
          data-session-id={s.id}
          data-persistent={persistentOf(s) ? "true" : undefined}
          onClick={() => onSelect?.(s.id)}
          aria-current={active ? "page" : undefined}
          // No `title` — the card IS the tooltip, and a native tooltip
          // fading in on top of it would cover the thing it duplicates.
          // The accessible NAME still carries the session's title.
          aria-label={s.title || UNTITLED_SESSION}
          className={cn(
            "group relative flex size-8 flex-none items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            // The active cell was a half-opacity blue ring on a surface
            // fill — two low-contrast signals that, at 32px against a
            // panel that is nearly the same value, read as "slightly
            // smudged" rather than as "you are here". It now gets the
            // accent BAR (see below) plus a solid fill, and the ring is
            // gone: a ring and a bar both claiming selection is one signal
            // too many, and the bar is the one that survives at a glance.
            // `bg-surface` for the fill matches `SessionRow`'s active
            // treatment, so the same session looks selected the same way
            // in both sidebar states.
            active ? "bg-surface" : "hover:bg-surface/40"
          )}
        >
          {/* The rail's own left edge, not the cell's: 32px of cell centred
              in 52px of rail leaves exactly 10px, so `-left-2.5` lands the
              bar on the panel border where every editor puts it. */}
          {active && (
            <span
              aria-hidden
              className="absolute -left-2.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-blue"
            />
          )}
          {/* The HARNESS, not two initials. Initials of an auto-generated
              title ("UN" for Untitled) say nothing you didn't already
              know, and two sessions on the same feature collide; which
              agent is driving is the fact you actually navigate by. */}
          <ProviderIcon
            cli={s.cli}
            size={16}
            // Brand colour for the active session, monochrome for the
            // rest — so the rail reads as one selected thing among peers
            // rather than as a row of competing logos.
            mono={!active}
            className={cn(
              "transition-colors",
              !active && "text-muted-foreground group-hover:text-text"
            )}
          />
          {/* Bottom-right rather than inline: a 32px cell has no room for a
              dot beside the icon without pushing it off-centre. */}
          <span className="absolute -bottom-px -right-px">
            <StatusDot status={displayStatusTone[status]} size={7} />
          </span>
        </button>
      </HoverCard>
    )
  }

  return (
    <div
      style={{ width: RAIL_WIDTH }}
      data-testid="session-rail"
      className="flex flex-none flex-col items-center gap-1 overflow-hidden py-2"
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand sidebar"
        title="Expand sidebar (⌘B)"
        className="flex size-8 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelLeft size={15} />
      </button>
      <button
        type="button"
        onClick={onNewSession}
        aria-label="New session"
        title="New session (⌘N)"
        className="flex size-8 flex-none items-center justify-center rounded-md text-dim outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus size={15} />
      </button>
      <span className="my-1 h-px w-6 flex-none bg-hairline" />
      {memoryEligible && (
        <button
          type="button"
          data-testid="memory-rail-item"
          onClick={onOpenMemory}
          aria-current={memoryActive ? "page" : undefined}
          aria-label="Memory"
          title="Memory"
          className={cn(
            "flex size-8 flex-none items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            memoryActive
              ? "bg-surface text-blue"
              : "text-dim hover:bg-surface hover:text-text"
          )}
        >
          <BrainCircuit size={16} />
        </button>
      )}
      <div className="sb-no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {persistent.map(renderCell)}
        {persistent.length > 0 && ordinary.length > 0 && (
          <span
            data-testid="persistent-rail-separator"
            className="my-1 h-px w-6 flex-none bg-hairline"
          />
        )}
        {ordinary.map(renderCell)}
      </div>
    </div>
  )
}

/**
 * The session sidebar, at whatever width the shell can spare.
 *
 * Above `RAIL_THRESHOLD` this is the docked, drag-resizable column it has always
 * been. Below it, the column becomes a 52px rail whose cells each carry a
 * `SessionHoverCard` — so collapsing costs REACH (one hover, one click) rather
 * than information.
 *
 * Either state can be forced with ⌘B or with the `PanelLeft` button, which
 * exists in both: in the docked header to collapse, at the top of the rail to
 * expand. The choice is persisted, so an operator who would rather give up
 * content width than navigate by hover only has to say so once.
 */
export function SessionSidebar(props: SessionSidebarProps) {
  // The SHELL's width, from the provider in `app-shell.tsx` — not this
  // component's own box, which is the sidebar and would always report ~266px
  // and so always claim to be cramped.
  const { width: shellWidth } = usePaneWidth()
  const { width, adjust } = useResizableWidth(SIDEBAR_WIDTH)
  const [pinned, setPinned] = React.useState<boolean | null>(readPinned)

  // `shellWidth === 0` is the pre-measurement frame; treat it as roomy so the
  // sidebar doesn't flash a rail on every launch before the observer reports.
  const cramped = shellWidth !== 0 && shellWidth < RAIL_THRESHOLD
  const expanded = pinned ?? !cramped

  const setPin = React.useCallback((next: boolean) => {
    setPinned(next)
    try {
      localStorage.setItem(PIN_STORAGE_KEY, next ? "1" : "0")
    } catch {
      /* private mode / quota — the pin is still live for this session */
    }
  }, [])

  // ⌘B toggles the pin. Deliberately a PIN and not a one-shot open: a toggle
  // that the next resize silently undoes is a control that lies about its state.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault()
        setPin(!(pinned ?? !cramped))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pinned, cramped, setPin])

  if (expanded) {
    return (
      <SidebarBody
        {...props}
        width={width}
        onResize={adjust}
        onCollapse={() => setPin(false)}
      />
    )
  }

  return (
    <SessionRail
      sessions={props.sessions}
      activeSessionId={props.activeSessionId}
      liveActivity={props.liveActivity}
      prStates={props.prStates}
      onSelect={props.onSelect}
      onNewSession={props.onNewSession}
      memoryEligible={props.memoryEligible}
      memoryActive={props.memoryActive}
      onOpenMemory={props.onOpenMemory}
      onExpand={() => setPin(true)}
    />
  )
}
