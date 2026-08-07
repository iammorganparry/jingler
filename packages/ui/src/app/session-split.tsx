import { useCallback, useState, type ReactNode } from "react"
import type { DiffStat, Session, SessionActivity } from "@jingler/core"
import type { DockSide } from "./terminal-panel.js"
import type { Pane, SplitGroup } from "./split-layout.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { effectiveDock } from "./dock-fit.js"
import { SplitView } from "./split-view.js"
import { SessionPane, type ConversationPaneCtx } from "../screens/session-pane.js"
import type { TabContribution, TabKey } from "./tab-contributions.js"
import { dockedPanes, type PaneContribution } from "./pane-contributions.js"

export interface SessionSplitProps {
  /** The group on screen — one pane per session. `null` renders the empty state. */
  group: SplitGroup | null
  sessions: ReadonlyArray<Session>
  /** Move the focus ring (and, downstream, singleton ownership) to a pane. */
  onFocusPane?: (index: number) => void
  /** A session was dropped on a pane's edge — insert it as a new pane at `at`. */
  onSplitWith?: (sessionId: string, at: number) => void
  /** A session was dropped on a pane's middle — swap that pane's session. */
  onReplacePane?: (index: number, sessionId: string) => void
  /** Continuous divider drag, as a fraction of the row's width. */
  onResize?: (index: number, delta: number) => void
  /** Close one pane, leaving its session running. */
  onClosePane?: (index: number) => void
  /** Reorder the focused pane — Arc's Move Left / Move Right. */
  onMovePane?: (index: number, direction: -1 | 1) => void
  /** Shown when nothing is on screen at all. */
  emptyState?: ReactNode
  /** Everything a pane needs to render one session. */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Render one pane's session-native repository browser and editor. */
  renderFiles?: (
    session: Session,
    ctx: { readonly onSelectConversation: () => void }
  ) => ReactNode
  renderBrowser?: (session: Session) => ReactNode
  onOpenFile?: (sessionId: string, path: string) => void
  conversationPane?: ReactNode
  /**
   * Render a session's chat pills into the tab row's `chatSlot`. A render prop
   * for the same reason `renderConversation` is: the chat state it drives (RPCs
   * + live per-chat activity) lives in the desktop renderer, so building the bar
   * here would drag the RPC client into the component library.
   */
  renderChatTabs?: (
    session: Session,
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
      readonly onSelectFiles: () => void
    }
  ) => ReactNode
  /** Rename a session from its pane title. */
  onRenameSession?: (id: string, title: string) => void
  onToggleBrowser?: (sessionId: string) => void
  isBrowserActive?: (sessionId: string) => boolean
  planSessions?: ReadonlySet<string>
  liveActivity?: Record<string, SessionActivity>
  liveDiff?: Record<string, DiffStat>
  onOpenSettings?: () => void
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Tabs contributed by plugins, merged with the built-ins in `SessionPane`. */
  tabContributions?: ReadonlyArray<TabContribution>
  /**
   * Dock panels contributed by plugins.
   *
   * Mounted once beside the terminal and browser docks — NOT inside the pane
   * loop. A dock belongs to the window; putting one in the loop would render
   * four copies in a four-way split, all fighting over the same state.
   */
  paneContributions?: ReadonlyArray<PaneContribution>
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderTerminalDock?: (session: Session) => ReactNode
  terminalDockSide?: DockSide
  /**
   * A palette request to switch tabs, handed to the FOCUSED pane only.
   *
   * Broadcasting it would switch all four tabs in a four-way split, which is not
   * what "go to Changes" means — the operator is looking at one pane.
   */
  selectTabRequest?: { readonly tabId: TabKey; readonly nonce: number } | null
  /** Told when the focused pane has applied the request, so it can be dropped. */
  onTabRequestHandled?: () => void
}

/**
 * The split, wired to real sessions — `SplitView`'s geometry with a live
 * `SessionPane` inside each pane, and the shared terminal dock mounted around it.
 *
 * The layering is deliberate: `SplitView` knows about panes, ratios and drops and
 * nothing about sessions, which is what let it be approved in Storybook against
 * placeholders. This file is the only place the two meet.
 */
export function SessionSplit(props: SessionSplitProps) {
  const { group, sessions } = props
  const [activeTabs, setActiveTabs] = useState<Readonly<Record<string, TabKey>>>({})
  const reportActiveTab = useCallback((sessionId: string, tabId: TabKey) => {
    setActiveTabs((current) =>
      current[sessionId] === tabId ? current : { ...current, [sessionId]: tabId }
    )
  }, [])
  const panes = group?.panes ?? []
  const single = panes.length <= 1

  // The session the per-session docks follow: the focused pane's, falling back to
  // the first pane so closing the focused one never strands them.
  const dockSessionId =
    group === null
      ? null
      : (group.panes[group.focused]?.sessionId ?? group.panes[0]?.sessionId ?? null)
  const dockSession =
    dockSessionId === null ? null : (sessions.find((s) => s.id === dockSessionId) ?? null)

  const renderPane = (pane: Pane, index: number) => {
    const session = sessions.find((s) => s.id === pane.sessionId)
    // A pane pointing at a session that has gone is transient — `prune` in
    // `useSplitLayout` removes it on the next tick. Render nothing rather than
    // throwing in the frame between.
    if (!session) return null
    return (
      <SessionPane
        session={session}
        renderConversation={props.renderConversation}
        renderFiles={props.renderFiles}
        renderBrowser={props.renderBrowser}
        onOpenFile={props.onOpenFile}
        conversationPane={props.conversationPane}
        renderChatTabs={props.renderChatTabs}
        onRenameSession={props.onRenameSession}
        onToggleBrowser={props.onToggleBrowser}
        isBrowserActive={props.isBrowserActive}
        planSessions={props.planSessions}
        liveActivity={props.liveActivity}
        liveDiff={props.liveDiff}
        onOpenSettings={props.onOpenSettings}
        // Identity only where it disambiguates: a group of one needs no chip,
        // and `group` is non-null wherever a pane is being rendered at all.
        pane={single ? undefined : { index, focused: index === (group?.focused ?? 0) }}
        selectTabRequest={index === (group?.focused ?? 0) ? props.selectTabRequest : undefined}
        onTabRequestHandled={props.onTabRequestHandled}
        onActiveTabChange={reportActiveTab}
        renderPullRequest={props.renderPullRequest}
        tabContributions={props.tabContributions}
        renderReview={props.renderReview}
        renderCode={props.renderCode}
        // No close control in a group of one: there is nothing to close back to,
        // so it would only be a way to blank the app.
        onClosePane={single || !props.onClosePane ? undefined : () => props.onClosePane?.(index)}
        // Reordering only means something with a neighbour to trade places with;
        // the ends are handled by the reducer refusing to move past them.
        onMovePaneLeft={
          single || !props.onMovePane || index === 0
            ? undefined
            : () => props.onMovePane?.(index, -1)
        }
        onMovePaneRight={
          single || !props.onMovePane || index === panes.length - 1
            ? undefined
            : () => props.onMovePane?.(index, 1)
        }
      />
    )
  }

  // The terminal dock is per-SESSION rather than per-pane, so it stays mounted
  // and simply takes whichever session currently owns it as a prop. Passing a
  // prop re-runs its queries; unmounting it would throw away the xterm buffer.
  const dock =
    dockSession && props.renderTerminalDock ? props.renderTerminalDock(dockSession) : null
  const filesFocused = dockSessionId !== null && activeTabs[dockSessionId] === "files"
  // Where each dock GOES. The same pure rule the docks apply to their own
  // borders and size (`dock-fit.ts`), evaluated against the same shell width, so
  // placement and appearance can't disagree — a right-docked panel rendered into
  // the bottom row would draw a left border across the middle of the window.
  const { width: shellWidth } = usePaneWidth()
  const termSide = effectiveDock(props.terminalDockSide ?? "bottom", shellWidth)
  // Plugin docks go through the SAME placement rule as the built-in ones. A
  // pane that chose its own side could sit at the bottom while drawing a left
  // border across the middle of the window.
  const pluginDocks = dockedPanes(props.paneContributions ?? [], (side) =>
    effectiveDock(side, shellWidth)
  )
  const renderDock = (pane: PaneContribution) => (
    <div
      key={pane.id}
      data-testid={`plugin-dock-${pane.id}`}
      className={filesFocused ? "hidden" : "flex min-h-0 min-w-0"}
    >
      {pane.render(dockSession)}
    </div>
  )
  const builtInDock = (node: ReactNode) => (
    <div className={filesFocused ? "hidden" : "contents"}>{node}</div>
  )

  // RIGHT-docked panes sit beside the whole split; BOTTOM-docked ones stack under
  // that row. Each dock CSS-hides itself when closed, so this holds for 0, 1 or 2
  // open docks on independent sides.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <SplitView
          group={group}
          renderPane={renderPane}
          onFocusPane={props.onFocusPane}
          onSplitWith={props.onSplitWith}
          onReplacePane={props.onReplacePane}
          onResize={props.onResize}
          emptyState={props.emptyState}
        />
        {termSide === "right" ? builtInDock(dock) : null}
        {pluginDocks.right.map(renderDock)}
      </div>
      {termSide === "bottom" ? builtInDock(dock) : null}
      {pluginDocks.bottom.map(renderDock)}
    </div>
  )
}
