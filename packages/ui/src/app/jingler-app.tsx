import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import type {
  ContextConfig,
  ContextSnapshot,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GitHubConnection,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  OrchestratorPreference,
  DiffStat,
  IssueSummary,
  ModelOption,
  OpencodeProviderInfo,
  SessionPrStatus,
  PrSummary,
  ProviderConfig,
  PlanTemplateConfig,
  ProvidersConfig,
  Repo,
  Session,
  SessionActivity,
  Usage,
  User,
  WorkerRoutingConfig
} from "@jingler/core"
import { UNTITLED_SESSION } from "@jingler/core"
import type { DockSide } from "./terminal-panel.js"
import { AppShell } from "./app-shell.js"
import { PreviewToggleButton } from "./preview-dock.js"
import { NewSessionDialog } from "../composites/new-session-dialog.js"
import { UsageModal } from "../composites/usage-modal.js"
import { SettingsView } from "../composites/settings-view.js"
import type { ConnectorCenterProps } from "../composites/connector-center.js"
import type { InjectionTargetsProps } from "../composites/injection-targets.js"
import type { OpenConnectorSectionProps } from "../composites/open-connector-section.js"
import type { ThemesSettingsProps } from "../composites/themes-settings.js"
import type { PluginsSettingsProps } from "../composites/plugins-settings.js"
import type { PaneContribution } from "./pane-contributions.js"
import { type ConversationPaneCtx, SessionConversation } from "../screens/session-conversation.js"
import { useSplitLayout } from "./use-split-layout.js"
import { MAX_PANES } from "./split-layout.js"
import { matchSplitShortcut } from "./split-shortcuts.js"
import {
  Archive,
  ArchiveRestore,
  LogOut,
  MonitorPlay,
  Settings as SettingsIcon,
  SquareTerminal,
  TerminalSquare
} from "lucide-react"
import { CommandPalette } from "./command-palette.js"
import { TitleSearch } from "./title-search.js"
import {
  matchPaletteChord,
  matchFileQuickOpenChord,
  PALETTE_GROUP,
  type PaletteItem,
  pluginGroupName,
  type PluginPaletteCommand
} from "./command-palette-model.js"
import { SEED_PATCH } from "../seed.js"
import {
  BUILTIN_TAB,
  builtinTabContributions,
  type TabContext,
  type TabContribution,
  type TabKey,
  visibleTabs
} from "./tab-contributions.js"

/**
 * The built-in tabs, with every body stubbed out.
 *
 * The palette needs to know which tabs a session CAN show, and that is decided
 * entirely by each contribution's `when(ctx)` — a predicate over the session,
 * whether it has a plan, and its diff. None of it touches a render callback, so
 * supplying real ones here would mean duplicating `SessionPane`'s six closures
 * in a second place purely to throw them away.
 *
 * Hoisted to module scope because it is constant: rebuilding it per render would
 * allocate the whole array on every keystroke in the palette.
 */
const TAB_SHAPES = builtinTabContributions({
  conversation: () => null,
  stub: () => null
})

const GITHUB_DISCONNECTED: GitHubConnection = {
  mode: "disconnected",
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null
}

export interface JinglerAppProps {
  clis: ReadonlyArray<CliInfo>
  /**
   * The harness new sessions start on (Settings · Providers). The New Session
   * dialog reads it instead of asking; absent falls back to the first installed.
   */
  defaultCli?: CliKind | null
  /** Persist the default harness for new sessions. */
  onSaveDefaultCli?: (cli: CliKind) => Promise<void> | void
  /** Preferred harness/model for orchestrator chats created in new sessions. */
  orchestrator?: OrchestratorPreference | null
  onSaveOrchestrator?: (
    orchestrator: OrchestratorPreference
  ) => Promise<void> | void
  /** Complexity-based concrete routes for implementation workers. */
  workerRouting?: WorkerRoutingConfig | null
  onSaveWorkerRouting?: (
    routing: WorkerRoutingConfig
  ) => Promise<void> | void
  sessions: ReadonlyArray<Session>
  /** The signed-in user, shown in the sidebar footer account menu. */
  user?: User
  /** Sign out of the app (from the account menu). */
  onSignOut?: () => void
  /** Repos discovered under the workspace, for the New Session picker. */
  repos?: ReadonlyArray<Repo>
  /** Absolute paths of starred repos — surfaced first in the picker + sidebar. */
  starredRepos?: ReadonlyArray<string>
  /** Toggle a repo's starred state (by absolute path); persists upstream. */
  onToggleStar?: (repoPath: string) => void | Promise<void>
  /**
   * Absolute paths of repos collapsed in the sidebar; the sentinel
   * `"__archived__"` collapses the Archived group.
   */
  collapsedRepos?: ReadonlyArray<string>
  /** Toggle a repo's collapsed state (by absolute path or the archived sentinel). */
  onToggleCollapsed?: (repoPath: string) => void | Promise<void>
  /** Preselect this repo (by path) when the New Session dialog opens. */
  defaultRepoPath?: string | null
  /** Live shared GitHub App connection (not the BetterAuth login identity). */
  githubConnection?: GitHubConnection
  githubBusy?: boolean
  onGithubConnect?: () => void
  onGithubManage?: () => void
  onGithubRefresh?: () => void
  onGithubDisconnect?: () => void
  /** What each session's agent is doing right now ("Running npm test"), keyed by id. */
  liveActivity?: Record<string, SessionActivity>
  /** Live linked-PR state per session id, badged onto sidebar rows. */
  prStates?: Record<string, SessionPrStatus>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Provider usage snapshot for the Usage & limits modal. */
  usage?: Usage | null
  /** Fetch fresh usage (called when the modal opens); may be async. */
  onLoadUsage?: () => Promise<void> | void
  /** Persisted GitHub integration preferences (for the settings modal). */
  githubConfig?: GithubConfig | null
  /** Persist GitHub preferences; presence wires the GitHub settings entry point. */
  onSaveGithubConfig?: (config: GithubConfig) => Promise<void> | void
  /** Auto-compaction levers, persisted to `WorkspaceConfig.context`. */
  contextConfig?: ContextConfig | null
  onSaveContextConfig?: (config: ContextConfig) => Promise<void> | void
  /** Live per-session context readings, so the budget can be set against reality. */
  contextSessions?: ReadonlyArray<{
    id: string
    title: string
    cli: CliKind
    snapshot: ContextSnapshot
  }>
  /** Persisted git preferences (for the settings modal's Git section). */
  gitConfig?: GitConfig | null
  /** Persist git preferences (the "share checked-out branches" lever). */
  onSaveGitConfig?: (config: GitConfig) => Promise<void> | void
  /** Desktop-notification prefs; absent means the defaults, not "off". */
  notificationsConfig?: NotificationsConfig | null
  onSaveNotificationsConfig?: (config: NotificationsConfig) => Promise<void> | void
  /** Whether plan mode runs its read-only commands unattended; absent means on. */
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => Promise<void> | void
  /** Whether final completion summaries are shaped for an ADHD reader. */
  adhdMode?: boolean | null
  onSaveAdhdMode?: (adhdMode: boolean) => Promise<void> | void
  /** Multiplier for conversation + code text size; absent means 1×. */
  fontScale?: number | null
  onSaveFontScale?: (fontScale: number) => Promise<void> | void
  /**
   * Everything Settings › Themes needs. Optional so the Storybook shell and the
   * component gallery can mount the app without a theme catalog; absent renders
   * the section's stub.
   */
  themes?: ThemesSettingsProps
  /** Everything Settings › Plugins needs. Absent renders the stub. */
  plugins?: PluginsSettingsProps
  /** Persisted per-CLI provider defaults (Settings · Providers view). */
  providersConfig?: ProvidersConfig | null
  /** Persist one CLI's provider defaults; presence wires the Settings gear. */
  onSaveProvider?: (cli: CliKind, config: ProviderConfig) => Promise<void> | void
  planTemplate?: PlanTemplateConfig | null
  onSavePlanTemplate?: (template: PlanTemplateConfig) => void
  /** Load the selectable models for a CLI (Settings · Providers). */
  loadModels?: (cli: CliKind) => Promise<ReadonlyArray<ModelOption>>
  /** opencode's resolved providers + credential origins (Settings · Providers). */
  loadOpencodeProviders?: () => Promise<ReadonlyArray<OpencodeProviderInfo>>
  /** Store an API key in opencode's own credential file. */
  onSetOpencodeAuth?: (providerId: string, key: string) => Promise<boolean>
  /** Unified MCP (OpenConnector) connection settings (Settings → Connectors). */
  unifiedMcp?: OpenConnectorSectionProps
  /** MCP Connector Center data + actions (Settings → Connector Center). */
  connector?: ConnectorCenterProps
  /** Per-harness injection readout (Settings → Connectors). */
  injection?: InjectionTargetsProps
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /**
   * Tabs contributed by plugins.
   *
   * Threaded rather than read from a context here because `packages/ui` has no
   * access to the plugin registry — and should not: the library stays a pure
   * consumer of contributions, whoever built them.
   */
  tabContributions?: ReadonlyArray<TabContribution>
  /**
   * Dock panes contributed by plugins.
   *
   * Threaded beside `tabContributions` rather than inferred: a dock belongs to
   * the window, so it is mounted once by `SessionSplit` outside the pane loop —
   * putting one inside would render four copies in a four-way split.
   */
  paneContributions?: ReadonlyArray<PaneContribution>
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Issue tab — the rich linked-issue view. */
  /** Render the per-session terminal dock (desktop app's live TerminalDock). */
  renderTerminalDock?: (session: Session) => ReactNode
  /** Which edge the terminal dock attaches to (drives the content column's flow). */
  terminalDockSide?: DockSide
  /**
   * Show/hide the terminal dock — the same toggle ⌃` drives.
   *
   * The dock's visibility is the renderer's (`use-terminal-dock.ts`), not this
   * shell's, so until the palette existed only `renderTerminalDock` needed to
   * cross the boundary: the shell laid the dock out but never asked for it. A
   * palette entry has to be able to ask.
   */
  onToggleTerminal?: () => void
  /** Whether the terminal dock is currently open (drives the palette's label). */
  terminalActive?: boolean
  /** Render the preview dock (the desktop app's PreviewDockView). */
  renderBrowserDock?: (session: Session | null) => ReactNode
  /** Which edge the preview dock attaches to. */
  browserDockSide?: DockSide
  /**
   * Toggle the preview dock. Rendered in the WINDOW TITLE BAR rather than in a
   * pane's tab bar: there is one dock and one native browser view for the whole
   * app, and a copy of the control in each pane implied one per pane.
   */
  onToggleBrowser?: () => void
  /** Whether the preview dock is currently open (highlights the toggle). */
  browserActive?: boolean
  activeSessionId?: string | null
  /**
   * Select a session from OUTSIDE the shell — a notification click, a deep link.
   * Bump this to a new value to jump there; the shell owns the selection
   * otherwise, so a plain prop would fight the operator's own clicks. Ignored
   * when null.
   */
  selectSessionRequest?: { readonly sessionId: string; readonly nonce: number } | null
  /**
   * Notified whenever the set of ON-SCREEN sessions changes. A set rather than a
   * single id because the grid shows several at once, and the desktop suppresses
   * notifications for anything the operator can already see.
   */
  onVisibleSessionsChange?: (sessionIds: ReadonlySet<string>) => void
  patch?: string
  /**
   * Render the live conversation for the active session. Called with the active
   * session, the `view` to show (transcript or Plan Review — both driven by the
   * same machine), and a ctx to open the Plan Review tab. Mounted keyed by
   * session id. Absent in stories → the seeded fallback renders.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Render the session-native repository browser and editor. */
  renderFiles?: (
    session: Session,
    ctx: { readonly onSelectConversation: () => void }
  ) => ReactNode
  /** Select a repository path in a session's persistent Files state. */
  onOpenFile?: (sessionId: string, path: string) => void
  /** Render the focused session's repository quick picker. */
  renderFileQuickOpen?: (
    session: Session,
    ctx: {
      readonly open: boolean
      readonly onOpenChange: (open: boolean) => void
      readonly onOpenPath: (path: string) => void
    }
  ) => ReactNode
  /**
   * Render a session's chat pills into the tab row's `chatSlot`. A render prop
   * for the same reason `renderConversation` is: the chat state it drives — the
   * create/select/rename/close RPCs and the live per-chat activity — lives in
   * the desktop renderer, so building the bar here would drag the RPC client
   * into the component library. Absent in stories.
   */
  renderChatTabs?: (
    session: Session,
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
      readonly onSelectFiles: () => void
    }
  ) => ReactNode
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** Load branch names for a repo (New Session base picker). */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  /** Create a session (forks a real worktree) and return it. */
  onCreateSession?: (input: CreateSessionInput) => Promise<Session>
  /** Manually rename a session (double-click its sidebar title) — pins the name. */
  onRenameSession?: (id: string, title: string) => void
  /** Persist or unpersist a session and return its updated record upstream. */
  onSetSessionPersistent?: (
    id: string,
    persistent: boolean
  ) => Promise<void> | void
  /** Archive an active session from the sidebar quick-actions (undoable). */
  onArchiveSession?: (id: string) => void
  /** Restore an archived session from the sidebar quick-actions. */
  onRestoreSession?: (id: string) => void
  /** Permanently delete a session from the sidebar quick-actions (confirms first). */
  onDeleteSession?: (id: string) => void
  /**
   * List open PRs for a repo (the New Session "From PR" picker). Presence wires
   * the `Blank | From PR` toggle; absent (e.g. GitHub not connected) hides it.
   */
  loadPrs?: (repoPath: string, opts: { mine: boolean; search: string }) => Promise<ReadonlyArray<PrSummary>>
  /** Create a session from an existing PR (checks out its head branch) and return it. */
  onCreateSessionFromPr?: (input: CreateSessionFromPrInput) => Promise<Session>
  /**
   * List open issues for a repo. Presence (with `onCreateSessionFromIssue`) wires
   * the "From issue" mode; absent (GitHub not connected) hides it.
   */
  loadIssues?: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ) => Promise<ReadonlyArray<IssueSummary>>
  /** Create a session from a GitHub issue (forks a fresh branch, links it) and return it. */
  onCreateSessionFromIssue?: (input: CreateSessionFromIssueInput) => Promise<Session>
  /**
   * Commands contributed by loaded plugins, for the palette.
   *
   * Passed in rather than read here: this package has no RPC client and no
   * plugin registry, and dragging either into the component library to populate
   * one list would be the wrong trade. The renderer already holds both.
   */
  pluginCommands?: ReadonlyArray<PluginPaletteCommand>
  /** Dispatch one to its plugin's host half (`Plugins.invoke`). */
  onRunPluginCommand?: (pluginId: string, commandId: string) => void
  /** App version (from `__APP_VERSION__`), shown in the sidebar footer. */
  version?: string
  /** First-class paid-team Memory destination, rendered as a sidebar takeover. */
  memory?: {
    readonly eligible: boolean
    readonly active: boolean
    readonly content: ReactNode
    readonly onOpen: () => void
    readonly onClose: () => void
  }
}

const noBranches = async (): Promise<ReadonlyArray<string>> => []

/**
 * The product shell — the whole Jingler window, data-driven. The desktop
 * renderer feeds it discovered `clis`/`repos`, live GitHub App state, and the session list
 * over Effect RPC, plus the callbacks that create real worktrees.
 */
export function JinglerApp({
  clis,
  defaultCli,
  onSaveDefaultCli,
  orchestrator,
  onSaveOrchestrator,
  workerRouting,
  onSaveWorkerRouting,
  sessions,
  user,
  onSignOut,
  repos = [],
  starredRepos = [],
  onToggleStar,
  collapsedRepos = [],
  onToggleCollapsed,
  defaultRepoPath,
  githubConnection = GITHUB_DISCONNECTED,
  githubBusy,
  onGithubConnect,
  onGithubManage,
  onGithubRefresh,
  onGithubDisconnect,
  liveActivity,
  prStates,
  liveDiff,
  usage,
  onLoadUsage,
  githubConfig,
  onSaveGithubConfig,
  contextConfig,
  onSaveContextConfig,
  contextSessions,
  gitConfig,
  onSaveGitConfig,
  notificationsConfig,
  onSaveNotificationsConfig,
  planAutoRun,
  onSavePlanAutoRun,
  adhdMode,
  themes,
  plugins,
  onSaveAdhdMode,
  fontScale,
  onSaveFontScale,
  providersConfig,
  onSaveProvider,
  planTemplate,
  onSavePlanTemplate,
  loadModels,
  loadOpencodeProviders,
  onSetOpencodeAuth,
  unifiedMcp,
  connector,
  injection,
  renderPullRequest,
  tabContributions,
  paneContributions,
  renderReview,
  renderCode,
  renderTerminalDock,
  terminalDockSide,
  onToggleTerminal,
  terminalActive,
  pluginCommands,
  onRunPluginCommand,
  renderBrowserDock,
  browserDockSide,
  onToggleBrowser,
  browserActive,
  activeSessionId,
  selectSessionRequest,
  onVisibleSessionsChange,
  patch = SEED_PATCH,
  renderConversation,
  renderFiles,
  onOpenFile,
  renderFileQuickOpen,
  renderChatTabs,
  planSessions,
  loadBranches = noBranches,
  onCreateSession,
  onRenameSession,
  onSetSessionPersistent,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  loadPrs,
  onCreateSessionFromPr,
  loadIssues,
  onCreateSessionFromIssue,
  version,
  memory
}: JinglerAppProps) {
  // The split replaces what used to be a single `selected` useState. The focused
  // pane's session IS the old "selected" — every existing call site below still
  // reads `selected` / calls `setSelected` and behaves as it always did when the
  // group has one pane.
  const split = useSplitLayout(sessions, activeSessionId ?? sessions[0]?.id ?? null)
  const selected = split.activeSessionId
  const setSelected = split.selectSession
  const selectSession = useCallback(
    (id: string) => {
      memory?.onClose()
      setSelected(id)
    },
    [memory, setSelected]
  )
  const group = split.group
  const [newOpen, setNewOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageLoading, setUsageLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<"providers" | "github">("providers")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileQuickOpenSessionId, setFileQuickOpenSessionId] = useState<string | null>(null)
  /**
   * The palette's half of tab switching. Nonced, and CLEARED once applied.
   *
   * The nonce is so that asking for the tab you are already on still counts as
   * an ask — same shape as `selectSessionRequest`. The clearing is because a
   * pane is not `JinglerApp`: it is keyed by session id and remounts on every
   * session switch, so a request left standing would be replayed onto the next
   * session you opened, and onto whichever pane you focused next in a split.
   */
  const [tabRequest, setTabRequest] = useState<{ tabId: TabKey; nonce: number } | null>(null)
  const clearTabRequest = useCallback(() => setTabRequest(null), [])

  // An outside request to jump to a session (notification click). Keyed on the
  // NONCE, not the id: clicking two notifications for the same session must
  // still land there the second time, and depending on the id alone would fight
  // the operator every time they navigated away from it themselves.
  const requestNonce = selectSessionRequest?.nonce
  const requestId = selectSessionRequest?.sessionId
  useEffect(() => {
    if (requestId === undefined) return
    setSelected(requestId)
    // Jumping to a session means SHOWING it — a notification that lands the
    // operator behind the Settings dialog has not done its job.
    setSettingsOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nonce is the trigger
  }, [requestNonce])

  // Publish the selection so the notifier can tell whether a session is the one
  // already on screen (see `active-session.ts` in the desktop renderer).
  useEffect(() => {
    onVisibleSessionsChange?.(split.visibleSessionIds)
  }, [split.visibleSessionIds, onVisibleSessionsChange])

  const openUsage = useCallback(() => {
    setUsageOpen(true)
    const result = onLoadUsage?.()
    if (result && typeof (result as Promise<void>).then === "function") {
      setUsageLoading(true)
      void (result as Promise<void>).finally(() => setUsageLoading(false))
    }
  }, [onLoadUsage])

  const ghConnected =
    githubConnection.connected &&
    githubConnection.installations.some((installation) => installation.status === "active")

  // The sidebar groups sessions by repo *name* (Session.repo === Repo.name), so
  // translate the path-keyed stars into the names those groups pin on.
  const starredRepoNames = useMemo(() => {
    const paths = new Set(starredRepos)
    return new Set(repos.filter((r) => paths.has(r.path)).map((r) => r.name))
  }, [repos, starredRepos])
  const repoOwners = useMemo(() => {
    const owners: Record<string, string> = {}
    for (const session of sessions) {
      const repo = repos.find(
        (candidate) => candidate.path === session.repoPath || candidate.name === session.repo
      )
      const owner = repo?.githubSlug?.split("/")[0]
      if (owner) owners[session.id] = owner
    }
    return owners
  }, [repos, sessions])
  const toggleStarByName = useCallback(
    (repoName: string) => {
      const repo = repos.find((r) => r.name === repoName)
      if (repo) return onToggleStar?.(repo.path)
    },
    [repos, onToggleStar]
  )

  // Same path→name translation for collapsed repos.
  //
  // The archived sentinel that used to be threaded through here is gone with the
  // Archived GROUP it collapsed — archived is a filter now, not a place. A stale
  // `__archived__` left in a persisted `collapsedRepos` matches no repo path and
  // is simply ignored, so no migration is needed.
  const collapsedRepoNames = useMemo(
    () => {
      const paths = new Set(collapsedRepos)
      return new Set(repos.filter((r) => paths.has(r.path)).map((r) => r.name))
    },
    [repos, collapsedRepos]
  )
  const toggleCollapsedByName = useCallback(
    (repoName: string) => {
      const repo = repos.find((r) => r.name === repoName)
      if (repo) return onToggleCollapsed?.(repo.path)
    },
    [repos, onToggleCollapsed]
  )

  const active = sessions.find((s) => s.id === selected) ?? null
  const fileQuickOpenSession =
    sessions.find((session) => session.id === fileQuickOpenSessionId) ?? null
  // `renderConversation` is passed straight down now. It used to be wrapped in a
  // closure that baked in the single active session; each SessionPane calls it
  // with its OWN session, which is what lets the grid render several at once.
  //
  // The empty state is for an empty WORKSPACE, never merely an empty pane. A
  // split always has a session in every pane — closing the last one is what
  // leaves no group at all, and that is the only thing the first-launch screen
  // should answer to.
  const showEmpty = Boolean(renderConversation) && group === null

  // Which pane each ON-SCREEN session sits in, for the sidebar's numbered badges.
  // Only the active group is badged: those are the panes the numbers refer to,
  // and the ⌃⇧1..4 shortcuts below address exactly the same set.
  const paneBySession = useMemo(() => {
    const map = new Map<string, number>()
    group?.panes.forEach((p, i) => {
      map.set(p.sessionId, i)
    })
    return map
  }, [group])

  /** Merge a session into the active group at `at` — a drop, or ⌃⇧=. */
  const splitActiveWith = useCallback(
    (sessionId: string, at: number) => {
      if (group) split.splitInto(group.id, sessionId, at)
    },
    [group, split]
  )

  /**
   * Add a pane holding the first session not already on screen.
   *
   * Arc splits with a new tab; the nearest thing here is a session you have but
   * aren't looking at, which beats opening a pane onto nothing.
   *
   * ONE definition for the two ways to ask — ⌃⇧= and the ghost panel on the
   * right edge. They had a copy each, so a change of policy (most-recently-
   * active rather than first, say) would have had to be made twice to be made
   * at all, and the two controls would have quietly started doing different
   * things.
   *
   * Reports whether it added, because the keyboard path needs to know: a chord
   * that could not act should fall through rather than be swallowed.
   */
  const addNextSessionAsPane = useCallback((): boolean => {
    if (!group || group.panes.length >= MAX_PANES) return false
    const next = sessions.find((s) => !(s.archived || split.visibleSessionIds.has(s.id)))
    if (!next) return false
    splitActiveWith(next.id, group.panes.length)
    return true
  }, [group, sessions, split, splitActiveWith])

  // ⌘N opens New Session; the rest is Arc's split map. Which chord means what is
  // `matchSplitShortcut`'s job — a pure function, and its own unit test, because
  // the first version of this map compared `e.key` against unshifted characters
  // and so could never fire for ⌃⇧1..4 or ⌃⇧[ / ⌃⇧] (Shift makes those "!" and
  // "{"). What is left here is only the part that needs the app's state: whether
  // the thing the chord asked for is possible right now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchFileQuickOpenChord(e)) {
        if (!renderFileQuickOpen || active?.worktreePath == null) return
        e.preventDefault()
        setFileQuickOpenSessionId(active.id)
        return
      }
      // The palette goes FIRST, and in this listener rather than one of its own.
      // Three window-level keydown handlers racing for the same event is how a
      // chord ends up meaning two things depending on mount order.
      // `setPaletteOpen(true)` is idempotent, so holding ⌘K cannot stack dialogs.
      if (matchPaletteChord(e)) {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }

      // ⌘F lands here too, now that search is global.
      //
      // It used to live in the sidebar and focus its "Filter sessions…" field.
      // That field is gone — search moved to the title bar and is served by the
      // palette, which already indexes every session, every archived session and
      // every action. Leaving ⌘F bound to nothing would have been a regression
      // paid for by whoever had learnt it, and binding it to a second, narrower
      // search would be two implementations over one index.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }

      const shortcut = matchSplitShortcut(e)
      if (shortcut === null) return

      switch (shortcut.type) {
        case "new-session": {
          if (!onCreateSession) return
          e.preventDefault()
          setNewOpen(true)
          return
        }
        // Swallow the chord only if it actually added a pane — at the cap, or
        // with every session already on screen, ⌃⇧= has nothing to do and
        // shouldn't pretend otherwise.
        case "add-pane": {
          if (addNextSessionAsPane()) e.preventDefault()
          return
        }
        // Out-of-range is a no-op rather than a clamp: ⌃⇧4 in a two-pane split
        // means "the fourth pane", and there isn't one.
        case "focus-pane": {
          if (!group || shortcut.index >= group.panes.length) return
          e.preventDefault()
          split.focusPane(group.id, shortcut.index)
          return
        }
        // Stops at the ends (the reducer refuses to wrap): wrapping from the
        // last pane to the first reads as a jump, and in a two-pane split it
        // makes the two keys indistinguishable.
        case "focus-neighbour": {
          if (!group) return
          e.preventDefault()
          split.focusNeighbour(shortcut.direction)
          return
        }
        case "move-pane": {
          if (!group) return
          e.preventDefault()
          split.moveFocused(shortcut.direction)
          return
        }
        // The session keeps running; this closes the VIEW of it.
        case "close-pane": {
          if (!group || group.panes.length <= 1) return
          e.preventDefault()
          split.closeFocused()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCreateSession, group, split, addNextSessionAsPane, active, renderFileQuickOpen])

  /**
   * Everything the palette can do, as data.
   *
   * ## An unavailable capability produces NO row
   *
   * Every action here is gated on the prop that performs it. A Jingler built
   * without `onSignOut` should not offer "Sign out" greyed out — a row you can
   * arrow onto and select that then does nothing is indistinguishable from a
   * bug, and the palette is the one surface where you cannot see why a thing is
   * disabled. Absent is honest; inert is not.
   *
   * ## Archived sessions are last, not hidden
   *
   * The sidebar's default filter hides them, and copying that here would make
   * the palette answer "no results" for a session that plainly exists — the
   * exact failure the fuzzy matcher was added to avoid. They sit in their own
   * group at the bottom instead, because `groupPaletteItems` keeps the order
   * this array is built in.
   */
  const paletteItems = useMemo<ReadonlyArray<PaletteItem>>(() => {
    const items: PaletteItem[] = []

    const sessionItem = (s: Session): PaletteItem => ({
      id: `session:${s.id}`,
      kind: "session",
      label: s.title || UNTITLED_SESSION,
      detail: `${s.repo} · ${s.branch}`,
      group: s.archived ? PALETTE_GROUP.archived : PALETTE_GROUP.sessions,
      run: () => setSelected(s.id)
    })

    for (const s of sessions) if (!s.archived) items.push(sessionItem(s))

    if (onCreateSession) {
      items.push({
        id: "action:new-session",
        kind: "action",
        label: "New Session",
        group: PALETTE_GROUP.actions,
        hint: "⌘N",
        icon: SquareTerminal,
        run: () => setNewOpen(true)
      })
    }

    // Gated on a session as well as the prop. The terminal dock is per-SESSION —
    // `SessionSplit` renders it only when there is one to attach to — so in an
    // empty workspace this row would flip a localStorage preference and change
    // nothing on screen, with no error to read. That is the failure this whole
    // block's gating exists to prevent, arrived at from the other direction.
    //
    // Show Browser is deliberately NOT gated the same way: the preview dock
    // points at localhost and `renderBrowserDock` takes a nullable session, so
    // it opens perfectly well with nothing selected.
    if (onToggleTerminal && active) {
      items.push({
        id: "action:toggle-terminal",
        kind: "action",
        label: terminalActive ? "Hide Terminal" : "Show Terminal",
        group: PALETTE_GROUP.actions,
        hint: "⌃`",
        icon: TerminalSquare,
        run: onToggleTerminal
      })
    }

    if (onToggleBrowser) {
      items.push({
        id: "action:toggle-browser",
        kind: "action",
        // The label names what the chord will DO, not what is currently true —
        // "Browser: on" would leave you working out which way to read it.
        label: browserActive ? "Hide Browser" : "Show Browser",
        group: PALETTE_GROUP.actions,
        hint: "⌃⇧B",
        icon: MonitorPlay,
        run: onToggleBrowser
      })
    }

    // Archive and Restore are the SAME row in two states, and only ever one of
    // them, because a session is either archived or it is not.
    if (active && !active.archived && onArchiveSession) {
      items.push({
        id: "action:archive-session",
        kind: "action",
        label: "Archive Session",
        detail: active.title || UNTITLED_SESSION,
        group: PALETTE_GROUP.actions,
        icon: Archive,
        run: () => onArchiveSession(active.id)
      })
    }
    if (active?.archived && onRestoreSession) {
      items.push({
        id: "action:restore-session",
        kind: "action",
        label: "Restore Session",
        detail: active.title || UNTITLED_SESSION,
        group: PALETTE_GROUP.actions,
        icon: ArchiveRestore,
        run: () => onRestoreSession(active.id)
      })
    }

    // Gated on `onSaveProvider` for the same reason the sidebar's menu item is:
    // that prop is what makes the Settings view renderable at all.
    if (onSaveProvider) {
      items.push({
        id: "action:open-settings",
        kind: "action",
        label: "Open Settings",
        group: PALETTE_GROUP.actions,
        icon: SettingsIcon,
        run: () => setSettingsOpen(true)
      })
    }

    if (onSignOut) {
      items.push({
        id: "action:sign-out",
        kind: "action",
        label: "Sign out",
        group: PALETTE_GROUP.actions,
        icon: LogOut,
        run: onSignOut
      })
    }

    /**
     * "Go to <Tab>" for the tabs the ACTIVE session can actually show.
     *
     * Built from the same `when` predicates the pane uses rather than from a
     * hardcoded list, so a session with no plan is not offered "Go to Plan" and
     * a plugin's tab appears here the moment it appears in the tab bar. Offering
     * a tab that cannot open would be worse than offering none: the palette
     * would close, nothing would change, and there is no error to read.
     */
    if (active) {
      const tabCtx: TabContext = {
        session: active,
        hasPlan: planSessions?.has(active.id) ?? false,
        diff: liveDiff?.[active.id] ?? null
      }
      for (const tab of visibleTabs(tabCtx, [...TAB_SHAPES, ...(tabContributions ?? [])])) {
        items.push({
          id: `tab:${tab.id}`,
          kind: "tab",
          label: `Go to ${tab.label}`,
          group: PALETTE_GROUP.tabs,
          icon: tab.icon,
          run: () => setTabRequest((prev) => ({ tabId: tab.id, nonce: (prev?.nonce ?? 0) + 1 }))
        })
      }
    }

    // Grouped by the manifest's `category`, falling back to the plugin's name —
    // a heading of "Commands" over two plugins' rows would hide which one is
    // about to run, and a plugin command is the one row here that executes
    // third-party code.
    if (onRunPluginCommand) {
      for (const command of pluginCommands ?? []) {
        items.push({
          id: `plugin:${command.commandId}`,
          kind: "plugin",
          label: command.title,
          detail: command.pluginName,
          group: pluginGroupName(command.category, command.pluginName),
          run: () => onRunPluginCommand(command.pluginId, command.commandId)
        })
      }
    }

    for (const s of sessions) if (s.archived) items.push(sessionItem(s))

    return items
  }, [
    sessions,
    active,
    setSelected,
    onCreateSession,
    onToggleTerminal,
    terminalActive,
    onToggleBrowser,
    browserActive,
    onArchiveSession,
    onRestoreSession,
    onSaveProvider,
    onSignOut,
    planSessions,
    liveDiff,
    tabContributions,
    pluginCommands,
    onRunPluginCommand
  ])

  const handleCreate = useCallback(
    async (input: CreateSessionInput) => {
      if (!onCreateSession) return
      const session = await onCreateSession(input)
      setSelected(session.id)
    },
    [onCreateSession]
  )

  const handleCreateFromPr = useCallback(
    async (input: CreateSessionFromPrInput) => {
      if (!onCreateSessionFromPr) return
      const session = await onCreateSessionFromPr(input)
      setSelected(session.id)
    },
    [onCreateSessionFromPr]
  )

  const handleCreateFromIssue = useCallback(
    async (input: CreateSessionFromIssueInput) => {
      if (!onCreateSessionFromIssue) return
      const session = await onCreateSessionFromIssue(input)
      setSelected(session.id)
    },
    [onCreateSessionFromIssue]
  )

  return (
    // No layout picker in the title bar any more: the shape of the split is a
    // consequence of what you dragged where, not a mode you pick up front.
    <AppShell
      title="Jingler"
      search={<TitleSearch onOpen={() => setPaletteOpen(true)} />}
      actions={
        onToggleBrowser ? (
          <PreviewToggleButton active={browserActive ?? false} onClick={onToggleBrowser} />
        ) : undefined
      }
    >
      <SessionConversation
        sessions={sessions}
        clis={clis}
        activeSessionId={selected}
        onSelectSession={selectSession}
        group={group}
        splitGroups={split.workspace.groups}
        activeGroupId={split.workspace.activeGroupId}
        onFocusPane={(index) => group && split.focusPane(group.id, index)}
        onFocusGroupPane={(groupId, index) => {
          // A sidebar segment belongs to a group that may not be on screen, so
          // showing it is part of focusing it.
          split.activateGroup(groupId)
          split.focusPane(groupId, index)
        }}
        onSplitWith={splitActiveWith}
        onSplitGroupWith={split.splitInto}
        onReplacePane={(index, sessionId) => {
          // One reducer, not close-then-insert: group ids derive from the
          // leftmost pane, so closing pane 0 re-ids the group and the second
          // call would look up an id that no longer exists.
          if (!group) return
          if (group.panes.length === 1) return setSelected(sessionId)
          split.replacePane(group.id, index, sessionId)
        }}
        onClosePane={(index) => group && split.closePane(group.id, index)}
        onCloseGroupPane={split.closePane}
        onMovePane={(index, direction) => group && split.movePane(group.id, index, direction)}
        onSeparateAll={split.separateAll}
        onResizePane={(index, delta) => group && split.resizePane(group.id, index, delta)}
        slotBySession={paneBySession}
        onRenameSession={onRenameSession}
        onSetSessionPersistent={onSetSessionPersistent}
        onArchiveSession={onArchiveSession}
        onRestoreSession={onRestoreSession}
        onDeleteSession={onDeleteSession}
        renderConversation={renderConversation}
        renderFiles={renderFiles}
        onOpenFile={onOpenFile}
        renderChatTabs={renderChatTabs}
        planSessions={planSessions}
        showEmpty={showEmpty}
        patch={patch}
        liveActivity={liveActivity}
        prStates={prStates}
        repoOwners={repoOwners}
        liveDiff={liveDiff}
        onNewSession={onCreateSession ? () => setNewOpen(true) : undefined}
        user={user}
        onSignOut={onSignOut}
        onOpenUsage={onLoadUsage ? openUsage : undefined}
        onOpenSettings={
          onSaveProvider
            ? () => {
                memory?.onClose()
                setSettingsSection("providers")
                setSettingsOpen(true)
              }
            : undefined
        }
        onOpenGithubSettings={
          onSaveProvider
            ? () => {
                memory?.onClose()
                setSettingsSection("github")
                setSettingsOpen(true)
              }
            : undefined
        }
        memoryEligible={memory?.eligible}
        memoryActive={memory?.active}
        onOpenMemory={
          memory
            ? () => {
                setSettingsOpen(false)
                memory.onOpen()
              }
            : undefined
        }
        memoryView={memory?.active ? memory.content : undefined}
        settingsView={
          settingsOpen && onSaveProvider ? (
            <SettingsView
              key={settingsSection}
              initialSection={settingsSection}
              clis={clis}
              providers={providersConfig}
              onSaveProvider={onSaveProvider}
              defaultCli={defaultCli}
              onSaveDefaultCli={onSaveDefaultCli}
              orchestrator={orchestrator}
              onSaveOrchestrator={onSaveOrchestrator}
              workerRouting={workerRouting}
              onSaveWorkerRouting={onSaveWorkerRouting}
              planTemplate={planTemplate}
              onSavePlanTemplate={onSavePlanTemplate}
              loadModels={loadModels ?? (async () => [])}
              loadOpencodeProviders={loadOpencodeProviders}
              onSetOpencodeAuth={onSetOpencodeAuth}
              unifiedMcp={unifiedMcp}
              connector={connector}
              injection={injection}
              githubConnection={githubConnection}
              githubBusy={githubBusy}
              onGithubConnect={onGithubConnect}
              onGithubManage={onGithubManage}
              onGithubRefresh={onGithubRefresh}
              onGithubDisconnect={onGithubDisconnect}
              github={githubConfig}
              git={gitConfig}
              context={contextConfig}
              onSaveContext={onSaveContextConfig}
              contextSessions={contextSessions}
              onSaveGithub={onSaveGithubConfig}
              onSaveGit={onSaveGitConfig}
              notifications={notificationsConfig}
              onSaveNotifications={onSaveNotificationsConfig}
              planAutoRun={planAutoRun}
              onSavePlanAutoRun={onSavePlanAutoRun}
              adhdMode={adhdMode}
              onSaveAdhdMode={onSaveAdhdMode}
              fontScale={fontScale}
              onSaveFontScale={onSaveFontScale}
              themes={themes}
              plugins={plugins}
              onClose={() => setSettingsOpen(false)}
            />
          ) : undefined
        }
        ghConnected={ghConnected}
        starredRepoNames={starredRepoNames}
        onToggleStar={onToggleStar ? toggleStarByName : undefined}
        collapsedRepoNames={collapsedRepoNames}
        onToggleCollapsed={onToggleCollapsed ? toggleCollapsedByName : undefined}
        renderPullRequest={renderPullRequest}
        tabContributions={tabContributions}
        paneContributions={paneContributions}
        renderReview={renderReview}
        renderCode={renderCode}
        renderTerminalDock={renderTerminalDock}
        terminalDockSide={terminalDockSide}
        renderBrowserDock={renderBrowserDock}
        browserDockSide={browserDockSide}
        selectTabRequest={tabRequest}
        onTabRequestHandled={clearTabRequest}
        version={version}
      />
      {onCreateSession && (
        <NewSessionDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          repos={repos}
          starredRepos={starredRepos}
          onToggleStar={onToggleStar}
          defaultRepoPath={defaultRepoPath}
          clis={clis}
          defaultCli={defaultCli}
          loadBranches={loadBranches}
          onCreate={handleCreate}
          loadPrs={loadPrs}
          onCreateFromPr={onCreateSessionFromPr ? handleCreateFromPr : undefined}
          loadIssues={loadIssues}
          onCreateFromIssue={onCreateSessionFromIssue ? handleCreateFromIssue : undefined}
        />
      )}
      {onLoadUsage && (
        <UsageModal
          open={usageOpen}
          usage={usage}
          loading={usageLoading}
          onClose={() => setUsageOpen(false)}
        />
      )}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={paletteItems} />
      {fileQuickOpenSession && renderFileQuickOpen
        ? renderFileQuickOpen(fileQuickOpenSession, {
            open: true,
            onOpenChange: (open) => {
              if (!open) setFileQuickOpenSessionId(null)
            },
            onOpenPath: () => {
              setFileQuickOpenSessionId(null)
              setTabRequest((previous) => ({
                tabId: BUILTIN_TAB.files,
                nonce: (previous?.nonce ?? 0) + 1
              }))
            }
          })
        : null}
    </AppShell>
  )
}
