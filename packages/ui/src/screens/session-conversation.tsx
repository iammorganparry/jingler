import type { SessionChatActions } from "../app/session-tree.js"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type {
  DiffStat,
  Environment,
  IssueIdentity,
  Project,
  SessionPrStatus,
  Session,
  SessionActivity,
  User
} from "@jingler/core"
import type { PendingEnvironmentSession } from "../app/environment-session-startup-machine.js"
import { SessionSidebar, type SidebarReleaseNotes, type SidebarUpdate } from "../app/session-sidebar.js"
import { ProjectSidebar } from "../app/project-sidebar.js"
import { projectIdForSession, sessionsForProject, UNASSIGNED_PROJECT_ID } from "../app/project-navigation.js"
import { SessionSplit } from "../app/session-split.js"
import type { SplitGroup } from "../app/split-layout.js"
import { EmptyConversation } from "./empty-conversation.js"
import type { ConversationPaneCtx } from "./session-pane.js"
import { BUILTIN_TAB, type TabContribution, type TabKey } from "../app/tab-contributions.js"
import type { PaneContribution } from "../app/pane-contributions.js"

// The pane ctx is part of this screen's public surface (JinglerApp types its
// `renderConversation` callback with it), so keep it importable from here even
// though it's now defined alongside the pane that consumes it.
export type { ConversationPaneCtx } from "./session-pane.js"

export interface SessionConversationProps {
  onOpenCheckpoints?: (sessionId: string, trigger: HTMLButtonElement | null) => void

  /** Global command search shown at the top of the sidebar. */
  search?: ReactNode
  sessions: ReadonlyArray<Session>
  projects?: ReadonlyArray<Project>
  selectedProjectId?: string | null
  onSelectProject?: (projectId: string) => void
  projectsLoading?: boolean
  projectOwners?: Readonly<Record<string, string>>
  onAddProject?: () => void
  onNewSessionForProject?: (projectId: string) => void
  renderExplorer?: (session: Session, onOpenPath: (path: string) => void) => ReactNode
  environments?: ReadonlyArray<Environment>
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  /**
   * The split on screen — which sessions sit in which panes, in what proportion,
   * and which pane has the operator's attention. Absent in stories, where a
   * single implicit pane holding `activeSessionId` is synthesised instead.
   */
  group?: SplitGroup | null
  /** Start a new chat in a session (the editor "+" menu). */
  onCreateChat?: (sessionId: string) => void
  /** Discard an untouched chat when its last editor tab closes. */
  onCloseUntouchedChat?: (sessionId: string, chatId: string) => void
  /** Open the repository file picker for a session (the editor "+" menu). */
  onOpenFilePicker?: (sessionId: string) => void
  /** Manually rename a session (double-click its sidebar title). */
  onRenameSession?: (id: string, title: string) => void
  /** Make a nested chat-owned surface the session's canonical active chat. */
  onFocusChat?: (sessionId: string, chatId: string) => void
  /** Toggle the browser belonging to the named session. */
  onToggleBrowser?: (sessionId: string, chatId: string) => void
  /** Whether the named session's browser is currently visible. */
  isBrowserActive?: (sessionId: string, chatId: string) => boolean
  /** Archive an active session from the sidebar quick-actions (undoable). */
  onArchiveSession?: (id: string) => void
  /** Restore an archived session from the sidebar quick-actions. */
  onRestoreSession?: (id: string) => void
  /** Permanently delete a session from the sidebar quick-actions (confirms first). */
  onDeleteSession?: (id: string) => void
  /** Chat lifecycle actions for the sidebar's session tree. */
  chatActions?: SessionChatActions
  /**
   * The live conversation pane (the renderer's session-keyed
   * `ConversationView`). Falls back to a static seeded transcript when absent
   * (stories / standalone).
   */
  conversationPane?: ReactNode
  /**
   * The real app's session-keyed pane, rendered for BOTH the Conversation and
   * Plan tabs from the same machine (so switching to Plan never aborts a parked
   * plan run). `view` selects the face; `ctx.onOpenPlanReview` switches the tab.
   *
   * Takes the session explicitly rather than closing over the active one: the
   * grid mounts several panes at once, and each must render its OWN session.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Render the session-native repository browser and editor. */
  renderFiles?: (
    session: Session,
    ctx: {
      readonly onSelectConversation: () => void
      readonly onOpenPath: (path: string) => void
      readonly path?: string
      readonly onClosed?: () => void
    }
  ) => ReactNode
  /** Render the latest focused visual explanation. */
  renderExplanation?: (session: Session) => ReactNode
  /** Render the browser inside its owning session pane. */
  renderBrowser?: (session: Session, active: boolean) => ReactNode
  onTrackFile?: (sessionId: string, path: string) => void
  /** Open a file selected from the workspace Explorer and reveal its Files surface. */
  onOpenExplorerFile?: (sessionId: string, path: string) => void
  onRequestCloseFile?: (sessionId: string, path: string) => boolean
  /** Render children of the selected top-level agent in a second tab row. */
  renderSubagentTabs?: (
    session: Session,
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
    }
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  explanationSessions?: ReadonlySet<string>
  /**
   * Show the empty state instead of the grid. The HOST owns this rule — it is
   * not re-derived here. `JinglerApp` sets it when the grid is entirely empty
   * AND a live `renderConversation` is wired, so the Storybook/standalone path
   * (no live renderer) still shows its seeded transcript rather than the
   * first-launch screen.
   */
  showEmpty?: boolean
  /** Unified-diff patch for the Changes rail (fallback demo only). */
  patch?: string
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live activity by session, then chat, for the sidebar tree. */
  chatActivities?: Readonly<Record<string, Readonly<Record<string, SessionActivity>>>>
  /** Live linked-PR state per session id, badged onto sidebar rows. */
  prStates?: Record<string, SessionPrStatus>
  /** GitHub owner login per session, used for repository avatars in the sidebar. */
  repoOwners?: Readonly<Record<string, string>>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Loaded per-file worktree diff counts, keyed by session and path. */
  fileDiffs?: Readonly<Record<string, Readonly<Record<string, DiffStat>>>>
  debugStopSequences?: Readonly<Record<string, number>>
  /** Open the New Session view. */
  onNewSession?: () => void
  /** The signed-in user, shown in the sidebar footer account menu. */
  user?: User
  /** Open the Usage & limits modal (from the sidebar account menu). */
  onOpenUsage?: () => void
  /** Open the Settings view (from the sidebar account menu). */
  onOpenSettings?: () => void
  /** Open Settings directly on provider connections from runtime recovery. */
  onOpenProviderSettings?: () => void
  /** Open Settings directly on GitHub from a repository-access recovery action. */
  onOpenGithubSettings?: () => void
  /** Sign out (from the sidebar account menu). */
  onSignOut?: () => void
  /** Open the optional sign-in dialog (sidebar footer, while signed out). */
  onSignIn?: () => void
  /**
   * When set, the Settings view is open: it replaces the main pane (tabs +
   * conversation) while the sidebar stays visible. `onOpenSettings` toggles it.
   */
  settingsView?: ReactNode
  /** New-session creation takeover; keeps the sidebar visible. */
  newSessionView?: ReactNode
  /** Whether the mounted new-session view currently owns the main pane. */
  newSessionViewActive?: boolean
  /** Remote creation remains navigable before its durable Session record exists. */
  pendingEnvironmentSession?: PendingEnvironmentSession | null
  onSelectPendingEnvironmentSession?: () => void
  /** Global Pull Requests takeover. */
  pullRequestsView?: ReactNode
  pullRequestsActive?: boolean
  onOpenPullRequests?: () => void
  issuesView?: ReactNode
  issuesActive?: boolean
  onOpenIssues?: () => void
  /** Whether GitHub is connected (drives the sidebar cog's status dot). */
  ghConnected?: boolean
  /** Repo names (sidebar group keys) that are starred — pinned to the top. */
  starredRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's starred state from its sidebar header. */
  onToggleStar?: (repoName: string) => void | Promise<void>
  /** Repo names (sidebar group keys) collapsed to hide their sessions. */
  collapsedRepoNames?: ReadonlySet<string>
  /** Toggle a repo group's collapsed state from its sidebar header. */
  onToggleCollapsed?: (repoName: string) => void | Promise<void>
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void; onSelectReview: () => void }) => ReactNode
  /** Tabs contributed by plugins, merged with the built-ins in `SessionPane`. */
  tabContributions?: ReadonlyArray<TabContribution>
  /** Persist selection of a provider-scoped issue from a pane's right rail. */
  onSelectIssue?: (sessionId: string, issue: IssueIdentity) => void
  /** Dock panes contributed by plugins, mounted once beside the built-in docks. */
  paneContributions?: ReadonlyArray<PaneContribution>
  /**
   * Filter the host's Explorer to a session's changes. The sidebar switches to
   * the Explorer itself; the host owns which diff (PR or uncommitted) it shows.
   */
  onRevealChanges?: (sessionId: string) => void
  /** Review Focus: hold the sidebar collapsed so only the diff has the width. */
  sidebarCollapsed?: boolean
  /** Which sidebar view mounts first; stories and restored layouts can start on Explorer. */
  initialWorkspaceView?: "sessions" | "explorer"
  /** The review tray beside a session's panes; null until drafts exist. */
  renderReviewTray?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Issue tab — the rich linked-issue view (shown when one is linked). */
  /** Render the per-session Terminal view. */
  renderTerminalDock?: (session: Session, visible: boolean) => ReactNode
  /** App version, shown in the sidebar footer. */
  version?: string
  /** Available packaged-app update shown in the sidebar. */
  update?: SidebarUpdate
  releaseNotes?: SidebarReleaseNotes
  /**
   * A command-palette request to switch tabs. Passed straight through to the
   * split, which hands it to the focused pane only.
   */
  selectTabRequest?: { readonly tabId: TabKey; readonly nonce: number } | null
  /** Told when the focused pane has applied the request, so it can be dropped. */
  onTabRequestHandled?: () => void
}

/**
 * Screen 01 — the primary session workspace.
 *
 * Owns the app-level furniture: the sidebar, the Settings takeover, and the
 * first-launch empty state. Everything belonging to ONE session (its tab bar,
 * tab body and docks) lives in `SessionPane`, which is what the grid multiplies.
 */
export function SessionConversation(props: SessionConversationProps) {
  const projects = props.projects ?? []
  const activeSession = props.sessions.find((session) => session.id === props.activeSessionId) ?? null
  const activeSessionProjectId = activeSession
    ? projectIdForSession(activeSession, projects)
    : null
  const [localProjectId, setLocalProjectId] = useState(
    () => activeSessionProjectId ?? projects[0]?.id ?? UNASSIGNED_PROJECT_ID
  )
  const selectedProjectId = props.selectedProjectId ?? localProjectId
  const setSelectedProjectId = props.onSelectProject ?? setLocalProjectId
  const [workspaceView, setWorkspaceView] = useState<"sessions" | "explorer">(
    props.initialWorkspaceView ?? "sessions"
  )
  const onRevealChangesProp = props.onRevealChanges
  const [sidebarExpandRequest, setSidebarExpandRequest] = useState(0)
  const revealChanges = useCallback(
    (sessionId: string) => {
      setWorkspaceView("explorer")
      setSidebarExpandRequest((request) => request + 1)
      onRevealChangesProp?.(sessionId)
    },
    [onRevealChangesProp]
  )

  const lastSessionIds = useRef(new Map<string, string>())
  useEffect(() => {
    if (activeSessionProjectId !== null && props.activeSessionId !== null) {
      lastSessionIds.current.set(activeSessionProjectId, props.activeSessionId)
      setSelectedProjectId(activeSessionProjectId)
    }
  }, [activeSessionProjectId, props.activeSessionId, setSelectedProjectId])

  const projectSessions = useMemo(
    () => sessionsForProject(props.sessions, projects, selectedProjectId),
    [props.sessions, projects, selectedProjectId]
  )

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    const candidates = sessionsForProject(props.sessions, projects, projectId).filter((session) => !session.archived)
    const lastId = lastSessionIds.current.get(projectId)
    const session = candidates.find((candidate) => candidate.id === lastId) ??
      candidates.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (session) props.onSelectSession(session.id)
  }

  const openNewSession = () => {
    if (selectedProjectId !== UNASSIGNED_PROJECT_ID && props.onNewSessionForProject) {
      props.onNewSessionForProject(selectedProjectId)
      return
    }
    props.onNewSession?.()
  }

         function getProps() {
           if (props.pullRequestsView) return (props.pullRequestsView)
           if (props.issuesView) return (props.issuesView)
           if (props.settingsView) return (props.settingsView)
           if (props.showEmpty || activeSessionProjectId !== selectedProjectId) return (<EmptyConversation
            version={props.version}
            onNewSession={openNewSession}
          />)
           return (<SessionSplit
            onOpenCheckpoints={props.onOpenCheckpoints}
            group={group}
            sessions={props.sessions}
            emptyState={
              <span className="text-[12px] text-dim">Nothing on screen — pick a session</span>
            }
            renderConversation={props.renderConversation}
            renderExplanation={props.renderExplanation}
            renderFiles={props.renderFiles}
            renderBrowser={props.renderBrowser}
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
            debugStopSequences={props.debugStopSequences}
            onOpenSettings={props.onOpenGithubSettings ?? props.onOpenSettings}
            onOpenProviderSettings={props.onOpenProviderSettings ?? props.onOpenSettings}
            renderPullRequest={props.renderPullRequest}
            tabContributions={props.tabContributions}
            onSelectIssue={props.onSelectIssue}
            paneContributions={props.paneContributions}
            onRevealChanges={revealChanges}
            renderReviewTray={props.renderReviewTray}
            renderTerminalDock={props.renderTerminalDock}
            selectTabRequest={props.selectTabRequest}
            onTabRequestHandled={props.onTabRequestHandled}
          />)
         }

  // Stories and standalone use pass no split — synthesise the one-pane group
  // holding whatever `activeSessionId` says, so this screen renders identically
  // either way. A one-pane group is not a special case; it is what a single
  // session IS in this model.
  const group: SplitGroup | null =
    props.group !== undefined
      ? props.group
      : props.activeSessionId === null
        ? null
        : {
            id: "standalone",
            panes: [{ sessionId: props.activeSessionId, ratio: 1 }],
            focused: 0
          }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-panel">
      {props.projects !== undefined ? (
        <ProjectSidebar
          projects={projects}
          sessions={props.sessions}
          activeProjectId={selectedProjectId}
          liveActivity={props.liveActivity}
          projectOwners={props.projectOwners}
          loading={props.projectsLoading}
          onSelect={selectProject}
          onAddProject={props.onAddProject}
        />
      ) : null}
      <SessionSidebar
        search={props.search}
        workspaceView={workspaceView}
        forceCollapsed={props.sidebarCollapsed}
        expandRequest={sidebarExpandRequest}
        onWorkspaceViewChange={setWorkspaceView}
        explorer={
          activeSession && projectIdForSession(activeSession, projects) === selectedProjectId
            ? props.renderExplorer?.(activeSession, (path) =>
                props.onOpenExplorerFile?.(activeSession.id, path)
              )
            : <div className="p-4 text-[12px] text-dim">Select a session to explore its worktree.</div>
        }
        sessions={projectSessions}
        environments={props.environments}
        activeSessionId={props.activeSessionId}
        onSelect={props.onSelectSession}
        onRename={props.onRenameSession}
        chatActions={props.chatActions}
        onRequestCloseFile={props.onRequestCloseFile}
        onCloseView={(sessionId, surface) => {
          if (surface.id !== BUILTIN_TAB.browser || !surface.chatId) return
          if (props.isBrowserActive?.(sessionId, surface.chatId)) {
            props.onToggleBrowser?.(sessionId, surface.chatId)
          }
        }}
        chatActivities={props.chatActivities}
        fileDiffs={props.fileDiffs}
        onArchive={props.onArchiveSession}
        onRestore={props.onRestoreSession}
        onDelete={props.onDeleteSession}
        liveActivity={props.liveActivity}
        prStates={props.prStates}
        repoOwners={props.repoOwners}
        onNewSession={openNewSession}
        user={props.user}
        onOpenUsage={props.onOpenUsage}
        onOpenSettings={props.onOpenSettings}
        onSignOut={props.onSignOut}
        onSignIn={props.onSignIn}
        ghConnected={props.ghConnected}
        starredRepoNames={props.starredRepoNames}
        onToggleStar={props.onToggleStar}
        collapsedRepoNames={props.collapsedRepoNames}
        onToggleCollapsed={props.onToggleCollapsed}
        version={props.version}
        update={props.update}
        releaseNotes={props.releaseNotes}
        pullRequestsActive={props.pullRequestsActive}
        onOpenPullRequests={props.onOpenPullRequests}
        issuesActive={props.issuesActive}
        onOpenIssues={props.onOpenIssues}
        pendingEnvironmentSession={props.pendingEnvironmentSession}
        pendingEnvironmentSessionActive={props.newSessionViewActive}
        onSelectPendingEnvironmentSession={props.onSelectPendingEnvironmentSession}
      />

      <div className="m-2 ml-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-editor shadow-[0_0_0_1px_var(--sb-line),0_18px_50px_var(--sb-border)]">
        {props.newSessionView && (
          <div className={props.newSessionViewActive ? "flex min-h-0 flex-1" : "hidden"}>
            {props.newSessionView}
          </div>
        )}
        {!props.newSessionViewActive && (getProps())}
      </div>
      <div id="session-view-rail-portal" className="flex min-h-0 flex-none" />
    </div>
  )
}
