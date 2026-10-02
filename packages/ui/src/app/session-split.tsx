import type { ReactNode } from "react"
import type { DiffStat, IssueIdentity, Session, SessionActivity } from "@jingler/core"
import type { SplitGroup } from "./split-layout.js"
import { usePaneWidth } from "../hooks/width-tier.js"
import { effectiveDock } from "./dock-fit.js"
import {
  SessionPane,
  type ConversationPaneCtx
} from "../screens/session-pane.js"
import type { TabContribution, TabKey } from "./tab-contributions.js"
import { dockedPanes, type PaneContribution } from "./pane-contributions.js"

export interface SessionSplitProps {
  /** The group on screen — one pane per session. `null` renders the empty state. */
  group: SplitGroup | null
  sessions: ReadonlyArray<Session>
  /** Shown when nothing is on screen at all. */
  emptyState?: ReactNode
  /** Everything a pane needs to render one session. */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  renderExplanation?: (session: Session) => ReactNode
  /** Render one pane's session-native repository browser and editor. */
  renderFiles?: (
    session: Session,
    ctx: {
      readonly onSelectConversation: () => void
      readonly onOpenPath: (path: string) => void
      readonly path?: string
      readonly onClosed?: () => void
    }
  ) => ReactNode
  renderBrowser?: (session: Session, active: boolean) => ReactNode
  onTrackFile?: (sessionId: string, path: string) => void
  onRequestCloseFile?: (sessionId: string, path: string) => boolean
  conversationPane?: ReactNode
  /** Render children of the selected top-level agent in a second tab row. */
  renderSubagentTabs?: (
    session: Session,
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
    }
  ) => ReactNode
  /** Start a new chat in a session (the editor "+" menu). */
  onCreateChat?: (sessionId: string) => void
  /** Discard an untouched chat when its last editor tab closes. */
  onCloseUntouchedChat?: (sessionId: string, chatId: string) => void
  /** Open the repository file picker for a session (the editor "+" menu). */
  onOpenFilePicker?: (sessionId: string) => void
  /** Rename a session from its pane title. */
  onRenameSession?: (id: string, title: string) => void
  onFocusChat?: (sessionId: string, chatId: string) => void
  onToggleBrowser?: (sessionId: string, chatId: string) => void
  isBrowserActive?: (sessionId: string, chatId: string) => boolean
  planSessions?: ReadonlySet<string>
  explanationSessions?: ReadonlySet<string>
  liveActivity?: Record<string, SessionActivity>
  liveDiff?: Record<string, DiffStat>
  debugStopSequences?: Readonly<Record<string, number>>
  onOpenSettings?: () => void
  onOpenProviderSettings?: () => void
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void; onSelectReview: () => void }) => ReactNode
  /** Tabs contributed by plugins, merged with the built-ins in `SessionPane`. */
  tabContributions?: ReadonlyArray<TabContribution>
  /** Persist selection of a provider-scoped issue from a pane's right rail. */
  onSelectIssue?: (sessionId: string, issue: IssueIdentity) => void
  /**
   * Dock panels contributed by plugins.
   *
   * Mounted once beside the terminal and browser docks — NOT inside the pane
   * loop. A dock belongs to the window; putting one in the loop would render
   * three copies in a three-way split, all fighting over the same state.
   */
  paneContributions?: ReadonlyArray<PaneContribution>
  onRevealChanges?: (sessionId: string) => void
  renderReviewTray?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  renderTerminalDock?: (session: Session, visible: boolean) => ReactNode
  /**
   * A palette request to switch tabs, handed to the FOCUSED pane only.
   *
   * Broadcasting it would switch all three tabs in a three-way split, which is not
   * what "go to Changes" means — the operator is looking at one pane.
   */
  selectTabRequest?: { readonly tabId: TabKey; readonly nonce: number } | null
  /** Told when the focused pane has applied the request, so it can be dropped. */
  onTabRequestHandled?: () => void
}

/** The active session editor plus window-level plugin docks. */
export function SessionSplit(props: SessionSplitProps) {
  const { group, sessions } = props
  const sessionId = group?.panes[group.focused]?.sessionId ?? group?.panes[0]?.sessionId
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null
  const { width: shellWidth } = usePaneWidth()
  const pluginDocks = dockedPanes(props.paneContributions ?? [], (side) =>
    effectiveDock(side, shellWidth)
  )
  const renderDock = (pane: PaneContribution) => (
    <div
      key={pane.id}
      data-testid={`plugin-dock-${pane.id}`}
      className="flex min-h-0 min-w-0"
    >
      {pane.render(session)}
    </div>
  )
  const editor = session ? (
    <SessionPane
      session={session}
      renderConversation={props.renderConversation}
      renderExplanation={props.renderExplanation}
      renderFiles={props.renderFiles}
      renderBrowser={props.renderBrowser}
      renderTerminal={props.renderTerminalDock}
      onTrackFile={props.onTrackFile}
      onRequestCloseFile={props.onRequestCloseFile}
      conversationPane={props.conversationPane}
      renderSubagentTabs={props.renderSubagentTabs}
      onRenameSession={props.onRenameSession}
      onCreateChat={props.onCreateChat}
      onCloseUntouchedChat={props.onCloseUntouchedChat}
      onOpenFilePicker={props.onOpenFilePicker}
      onFocusChat={props.onFocusChat}
      onToggleBrowser={props.onToggleBrowser}
      isBrowserActive={props.isBrowserActive}
      planSessions={props.planSessions}
      explanationSessions={props.explanationSessions}
      liveActivity={props.liveActivity}
      liveDiff={props.liveDiff}
      debugStopSequence={props.debugStopSequences?.[session.id] ?? 0}
      onOpenSettings={props.onOpenSettings}
      onOpenProviderSettings={props.onOpenProviderSettings}
      selectTabRequest={props.selectTabRequest ?? undefined}
      onTabRequestHandled={props.onTabRequestHandled}
      renderPullRequest={props.renderPullRequest}
      tabContributions={props.tabContributions}
      onSelectIssue={props.onSelectIssue}
      onRevealChanges={props.onRevealChanges}
      renderReviewTray={props.renderReviewTray}
    />
  ) : (
    props.emptyState
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <div data-session={session?.id} className="flex min-h-0 min-w-0 flex-1">{editor}</div>
        {pluginDocks.right.map(renderDock)}
      </div>
      {pluginDocks.bottom.map(renderDock)}
    </div>
  )
}
