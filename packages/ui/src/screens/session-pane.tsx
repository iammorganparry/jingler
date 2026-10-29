import type { SubagentFleetNode } from "@jingler/core"
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { createPortal } from "react-dom"
import type {
  DiffStat,
  IssueIdentity,
  IssueReference,
  Session,
  SessionActivity,
  SessionPrStatus
} from "@jingler/core"
import {
  activeCheckoutOf,
  issueReferenceOf,
  issueReferencesOf,
  UNTITLED_SESSION
} from "@jingler/core"
import { WidthTierProvider } from "../hooks/width-tier.js"
import {
  BUILTIN_TAB,
  builtinTabContributions,
  describeTab,
  type TabContext,
  type TabContribution,
  type TabKey,
  visibleTabs
} from "../app/tab-contributions.js"
import { ConversationView } from "../app/conversation-view.js"
import { SEED_CONVERSATION } from "../seed.js"
import { BuiltinStubScreen } from "./stub-screen.js"
import { SessionPrsChip } from "../app/session-prs-chip.js"
import { sessionPrRows } from "../lib/session-prs.js"
import { SessionHeaderIdentity } from "../app/session-header-identity.js"
import { HeaderViewButtons, type HeaderLinkChip, type HeaderViewItem } from "../app/header-view-buttons.js"
import { ViewOverflowMenu } from "../app/view-overflow-menu.js"
import {
  SESSION_SURFACE_COMMAND_EVENT,
  sessionSurfaceKey,
  type SessionSurface,
  type SessionSurfaceCommand
} from "../app/session-surface-layout.js"
import {
  activateTab,
  applyEditorCommand,
  activeSurface,
  allTabs,
  chatLaneOnly,
  closeSurfaceEverywhere,
  closeTab,
  dropTab,
  focusEditorGroup,
  focusedGroup,
  groupsOf,
  loadEditorLayout,
  replaceLegacyTerminalView,
  openTab,
  pruneEditorLayout,
  resizeSplit,
  withoutChatLane,
  wouldCollapseChatLane,
  type EditorLayout
} from "../app/editor-layout.js"
import {
  editorLayoutOf,
  initEditorLayout,
  updateEditorLayout,
  useEditorLayout
} from "../app/editor-layout-machine.js"
import { EditorGroups, type EditorTabMeta } from "../app/editor-groups.js"
import { useChatLane } from "../app/use-chat-lane.js"
import { matchCollapseChatChord, matchFocusChatChord, matchChangesChord, matchChecksChord, matchHeaderViewChord } from "../app/app-shortcuts.js"
import { AskPill } from "../components/ask-pill.js"
import { ChatDrawer } from "../app/chat-drawer.js"
import type { TabLauncherItem } from "../app/chat-tab-bar.js"
import { CircleDot, File, GitPullRequest, MessageSquarePlus, MessagesSquare, SquareTerminal } from "lucide-react"
import { TerminalPanel, terminalTabLabel, type SessionTerminals, type TerminalTab, type UseSessionTerminals } from "../app/terminal-panel.js"
import { DiscardCommentsDialog } from "../composites/discard-comments-dialog.js"
import { planDraftCount, planDraftKey } from "../composites/plan-comment-drafts.js"
import { LinkedIssueSelector, type LinkedIssueSelectorItem } from "../composites/linked-issue-selector.js"

const issueMenuValue = (issue: IssueReference): string =>
  `${issue.providerId}:${issue.providerAccountId ?? ""}:${issue.id}`

/**
 * What the host hands the live conversation pane so it can drive the Plan tab.
 * There's no router here — this tiny ctx IS the app's plan-review navigation.
 */
export interface ConversationPaneCtx {
  /**
   * Switch to the Plan Review tab, optionally focused on a stage (the composer
   * progress dock deep-links; the inline plan card calls it bare).
   */
  onOpenPlanReview: (stepId?: string) => void
  /** Open a repository path in its own editor tab. */
  onOpenFile: (path: string) => void

  /** Reveal and focus the session browser for an operator-requested preview. */
  onSelectBrowser?: () => void
  /** Present canonical worktree changes for mutation recovery inspection. */
  onSelectChanges: () => void
  /** Open the session's pull request view (a subagent's PR chip). */
  onOpenPullRequest: () => void
  /** Open provider settings for authentication or certification recovery. */
  onOpenProviderSettings: () => void
  /** Present the first renderable streamed draft using this pane's width. */
  onPlanDraftAvailable?: () => void
  /** Drop a pending presentation when its streamed draft becomes invalid. */
  onPlanDraftUnavailable?: () => void
  /** The stage Plan Review should open at, until the one-shot target is consumed. */
  planStepId?: string | null
  /** Plan Review's selection moved — retires a spent `planStepId`. */
  onPlanStepSelected?: () => void
  /**
   * Whether this pane is the one the operator is looking at. Drives composer
   * autofocus, so in a split only the focused pane takes the caret.
   */
  paneFocused?: boolean
}

export interface SessionPaneProps {
  onOpenCheckpoints?: (sessionId: string, trigger: HTMLButtonElement | null) => void
  /** The session this pane shows. A pane only exists for a filled grid slot. */
  session: Session
  /** Restore the view this session last owned when its pane is mounted again. */
  initialTab?: TabKey
  /**
   * Switch tabs from OUTSIDE the pane — today, the command palette.
   *
   * **One-shot, and it has to be**, which is the same reasoning as `target`
   * below. A pane is keyed by `pane.sessionId` (see `split-view.tsx`), so it
   * REMOUNTS on every session switch — and a mount runs this effect with
   * whatever request is still hanging around. Left uncleared, one "Go to
   * Changes" would open every session you visited afterwards on Changes, and in
   * a split, focusing another pane would yank its tab to the same stale
   * request. `onTabRequestHandled` is what stops that: the pane reports the
   * request consumed and the owner drops it.
   *
   * The nonce does the OTHER half: asking for the tab you are already on has to
   * work, and a plain `tabId` would make the second ask a no-op. The pane still
   * owns its tab the rest of the time, so a controlled prop would fight every
   * click on the tab bar.
   *
   * Only the FOCUSED pane is given one — see `SessionSplit`.
   */
  selectTabRequest?: { readonly tabId: TabKey; readonly nonce: number } | null
  /** Told when {@link selectTabRequest} has been applied, so it can be dropped. */
  onTabRequestHandled?: () => void
  /** Reports this pane's selected view so window-level docks can yield to Files. */
  onActiveTabChange?: (sessionId: string, tabId: TabKey) => void
  /**
   * The real app's session-keyed pane, rendered for BOTH the Conversation and
   * Plan tabs from the same machine (so switching to Plan never aborts a parked
   * plan run). `view` selects the face; `ctx.onOpenPlanReview` switches the tab.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
  /** Render the latest focused visual explanation. */
  renderExplanation?: (session: Session) => ReactNode
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
  /** Render this session's embedded browser inside its pane. */
  renderBrowser?: (session: Session, visible: boolean) => ReactNode
  /** Hook supplying the session's shells; each one is its own editor tab. */
  useSessionTerminals?: UseSessionTerminals
  /**
   * List a path among the session's open files WITHOUT selecting it. A file
   * pane owns its own document; selecting its path in the shared actor would
   * retarget the Files view and repaint it every time another file opens.
   */
  onTrackFile?: (sessionId: string, path: string) => void
  /** Dirty-aware close request for a path-owned nested editor. */
  onRequestCloseFile?: (sessionId: string, path: string) => boolean
  /**
   * A static conversation pane for stories / standalone use, when no live
   * `renderConversation` is wired. Falls back again to the seeded transcript.
   */
  conversationPane?: ReactNode
  /** Fleet nodes per session id; any with a PR join the header PRs chip. */
  /** Open a session PR (main or subagent) in the PR view. */
  onOpenSessionPr?: (sessionId: string, prNumber: number) => void
  subagentPrNodes?: Readonly<Record<string, ReadonlyArray<SubagentFleetNode>>>
  /** Render the subagent chip for one chat in the lane header. */
  renderSubagentTabs?: (
    session: Session,
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
    }
  ) => ReactNode
  /** Rename the session from the tab-row title. */
  onRenameSession?: (id: string, title: string) => void
  /** Make a nested chat-owned surface the session's canonical active chat. */
  onFocusChat?: (sessionId: string, chatId: string) => void
  /** Toggle the embedded browser that belongs to this session. */
  onToggleBrowser?: (sessionId: string, chatId: string) => void
  /** Read this session's browser visibility without borrowing focused state. */
  isBrowserActive?: (sessionId: string, chatId: string) => boolean
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** Session ids with a published focused visual explanation. */
  explanationSessions?: ReadonlySet<string>
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Polled PR status per session, for the Checks `a/b` badge. */
  prStates?: Record<string, SessionPrStatus>
  /** Opens Files once when this session first stops in the debugger. */
  debugStopSequence?: number
  /** Open the Settings view — the "connect GitHub" escape hatch on empty states. */
  onOpenSettings?: () => void
  /** Open provider settings for runtime connection recovery. */
  onOpenProviderSettings?: () => void
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void; onSelectReview: () => void }) => ReactNode
  /**
   * Changes are reviewed in the Explorer: the Changes rail button (and every
   * "inspect changes" route) asks the host to show the Explorer filtered to
   * this session's changed files instead of opening a view.
   */
  onRevealChanges?: (sessionId: string) => void
  /**
   * The review tray beside this session's panes. The host returns null until
   * there is something to act on (collected drafts), so it costs no width.
   */
  renderReviewTray?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /**
   * Tabs contributed by plugins, merged with the built-ins into one list.
   *
   * One list, not two, and not a separate "plugin tabs" region of the bar: a
   * contributed tab sorts, renders, badges and unmounts by exactly the same
   * rules as Conversation does. Anything less and plugin tabs would drift into
   * being second-class the first time a built-in gained a behaviour the plugin
   * path forgot.
   */
  tabContributions?: ReadonlyArray<TabContribution>
  /**
   * This pane's place in the split, for the tab bar's identity chip. Absent in a
   * group of one — there, the pane IS the session and the chip would only label
   * the single thing on screen.
   */
  pane?: { index: number; focused: boolean }
  /** Close this pane. Absent in a group of one, where there is nothing to close back to. */
  onClosePane?: () => void
  /** Swap this pane with its left-hand neighbour. Absent at the left-hand end. */
  onMovePaneLeft?: () => void
  /** Swap this pane with its right-hand neighbour. Absent at the right-hand end. */
  onMovePaneRight?: () => void
  /** Start a new chat in this session (the "+" menu's Chat entry). */
  onCreateChat?: (sessionId: string) => void
  /** Discard an untouched chat when its last editor tab closes. */
  onCloseUntouchedChat?: (sessionId: string, chatId: string) => void
  /** Open the repository file picker for this session (the "+" menu's File entry). */
  onOpenFilePicker?: (sessionId: string) => void
  /** Persist selection of a provider-scoped issue from the header issue picker. */
  onSelectIssue?: (sessionId: string, issue: IssueIdentity) => void
  /** Plugin-supplied linked-issue pickers shown in the header, keyed by tab id; overrides the derived ones. */
  issueMenus?: Readonly<Record<TabKey, IssueMenu | undefined>>
  /** Pinned header view ids in order (`Config.headerViews`). Absent hides the header buttons. */
  headerViews?: ReadonlyArray<string>
  /** Persist a new pinned set, from the overflow menu's "Pin to header". */
  onHeaderViewsChange?: (views: ReadonlyArray<string>) => void
  /** Whether the file browser follows this chat's agent edits. */
  followAgent?: boolean
  /** Toggle the shared agent-follow mode. */
  onToggleFollowAgent?: (enabled: boolean) => void
}

/**
 * One session's full workspace: its tab bar and its tab body.
 *
 * The terminal remains a group-level dock. Browser state and presentation are
 * session-owned, so Browser renders inside this pane instead.
 *
 * Extracted out of `SessionConversation` so the split can mount SEVERAL of these
 * at once. The important consequence of the split is that `tab`, `target` and
 * `split` are per-pane state now — two panes showing different sessions must be
 * able to sit on different tabs, which a single shared `useState` in the parent
 * could never express.
 *
 * Mount this keyed by session id. The pane reads `props.session` directly rather
 * than looking an id up in a list, so a slot always renders the session it was
 * given even mid-reorder.
 */
/**
 * THE responsive boundary.
 *
 * Everything below here — the tab bar, the composer, a pane's side rails —
 * collapses against THIS pane's width, so a three-way split degrades each pane
 * independently and a single maximised pane keeps the full layout.
 *
 * Split into a provider and a body deliberately: a component cannot read the
 * context it is itself installing, and `SessionPaneBody` has to know its own
 * width to decide whether the plan split will fit.
 */
/** ⌘⇧D → Changes, ⌘⇧P → Checks (when present), ⌥1–⌥9 → pinned header view at that position. */
const viewChordTarget = (
  e: KeyboardEvent,
  hasChecks: boolean,
  pinned: ReadonlyArray<{ readonly id: string }>
): string | undefined => {
  if (matchChangesChord(e)) return BUILTIN_TAB.changes
  if (matchChecksChord(e)) return hasChecks ? BUILTIN_TAB.checks : undefined
  const position = matchHeaderViewChord(e)
  return position === null ? undefined : pinned[position]?.id
}

export function SessionPane(props: SessionPaneProps) {
  return (
    <WidthTierProvider className="flex-col">
      <SessionPaneBody {...props} />
    </WidthTierProvider>
  )
}

function resolveVisibleTab(tabs: ReadonlyArray<TabContribution>, tab: TabKey): TabKey {
  if (tabs.some((contribution) => contribution.id === tab)) return tab
  return tabs[0]?.id ?? BUILTIN_TAB.conversation
}

const noop = () => {}
const NO_SHELLS: ReadonlyArray<TerminalTab> = []

const discardUntouchedChat = (
  surface: SessionSurface,
  copies: number,
  sessionId: string,
  discard: SessionPaneProps["onCloseUntouchedChat"]
): void => {
  if (surface.kind === "chat" && copies <= 1) discard?.(sessionId, surface.id)
}

const killShell = (surface: SessionSurface, copies: number, terminals: SessionTerminals | undefined): void => {
  if (surface.kind === "terminal" && copies <= 1) void terminals?.close(surface.id)
}

const SurfaceContent = memo(function SurfaceContent({
  session, chatId, contribution, paneFocused, paneVisible, onSelectTab, onConnectGithub
}: {
  session: Session
  chatId: string
  contribution: TabContribution | undefined
  paneFocused: boolean
  paneVisible: boolean
  onSelectTab: (id: TabKey) => void
  onConnectGithub: () => void
}) {
  const paneSession = chatId === session.activeChatId ? session : { ...session, activeChatId: chatId }
  return contribution?.render(paneSession, {
    activeTabId: contribution.id,
    splitOpen: false,
    paneFocused,
    paneVisible,
    onConnectGithub,
    onSelectTab: (id) => { if (paneFocused || contribution.id === BUILTIN_TAB.conversation) onSelectTab(id) }
  })
})

const surfaceOwner = (surface: SessionSurface): string | undefined =>
  surface.kind === "chat" ? surface.id : surface.kind === "view" ? surface.chatId : undefined

const tabOf = (surface: SessionSurface): TabKey =>
  surface.kind === "view"
    ? surface.id
    : surface.kind === "terminal"
      ? BUILTIN_TAB.terminal
      : BUILTIN_TAB.conversation

/** A linked-issue picker for one issue-provider tab: derived from the session's linked issues, or supplied by a plugin. */
export interface IssueMenu {
  readonly value: string
  readonly ariaLabel: string
  readonly items: ReadonlyArray<LinkedIssueSelectorItem>
  readonly onSelect: (value: string) => void
}

function buildIssueMenu(
  session: Session,
  contribution: TabContribution | undefined,
  onSelectIssue: SessionPaneProps["onSelectIssue"]
): IssueMenu | undefined {
  const providerId = contribution?.issueProviderId
  if (!providerId || !onSelectIssue) return undefined
  const issues = issueReferencesOf(session).filter((issue) => issue.providerId === providerId)
  if (issues.length < 2) return undefined
  const selectedIssue = issueReferenceOf(session)
  const selected = selectedIssue?.providerId === providerId ? selectedIssue : issues[0]!
  return {
    value: issueMenuValue(selected),
    ariaLabel: `Select linked ${providerId[0]?.toUpperCase() ?? ""}${providerId.slice(1)} issue`,
    items: issues.map((issue) => ({ value: issueMenuValue(issue), identifier: issue.identifier, title: issue.title })),
    onSelect: (value) => {
      const issue = issues.find((candidate) => issueMenuValue(candidate) === value)
      if (!issue) return
      onSelectIssue(session.id, {
        providerId: issue.providerId,
        ...(issue.providerAccountId ? { providerAccountId: issue.providerAccountId } : {}),
        id: issue.id
      })
    }
  }
}

const chatTitleOf = (session: Session, chatId: string): string => {
  const index = session.chats.findIndex((chat) => chat.id === chatId)
  const chat = session.chats[index]
  return chat ? (chat.title ?? `Chat ${index + 1}`) : "Chat"
}

/** Tab label, icon and breadcrumb trail for one surface. */
function describeEditorSurface(
  surface: SessionSurface,
  session: Session,
  contributions: ReadonlyArray<TabContribution>,
  tabCtx: TabContext,
  shells: ReadonlyArray<TerminalTab>
): EditorTabMeta {
  const sessionLabel = session.title || UNTITLED_SESSION
  if (surface.kind === "terminal") {
    const label = terminalTabLabel(shells, surface.id)
    return { label, icon: SquareTerminal, crumbs: [sessionLabel, label] }
  }
  if (surface.kind === "chat") {
    const label = chatTitleOf(session, surface.id)
    return { label, icon: MessagesSquare }
  }
  if (surface.kind === "file") {
    return { label: surface.id.split("/").at(-1) ?? surface.id, crumbs: surface.id.split("/") }
  }
  const contribution = contributions.find((candidate) => candidate.id === surface.id)
  const label = contribution?.label ?? surface.id
  const owner = surface.chatId ? chatTitleOf(session, surface.chatId) : undefined
  const badge = contribution ? describeTab(contribution, tabCtx).badge : undefined
  return {
    label,
    icon: contribution?.icon,
    crumbs: owner ? [sessionLabel, owner, label] : [sessionLabel, label],
    ...(badge ? { badge } : {})
  }
}

function renderShell(
  terminals: SessionTerminals | undefined,
  id: string,
  visible: boolean,
  onRestart: (id: string) => void
): ReactNode {
  const tab = terminals?.tabs.find((candidate) => candidate.id === id)
  if (!(terminals && tab)) return null
  return (
    <TerminalPanel
      tab={tab}
      cwdLabel={terminals.cwdLabel}
      onRestart={onRestart}
      renderTerminal={(shellId) => terminals.renderTerminal(shellId, visible)}
    />
  )
}

function renderEditorBody(
  props: SessionPaneProps,
  active: Session,
  surface: SessionSurface,
  focused: boolean,
  visible: boolean,
  conversationContribution: TabContribution | undefined,
  contributions: ReadonlyArray<TabContribution>,
  selectTab: (id: TabKey) => void,
  openSurface: (surface: SessionSurface) => void,
  closeEverywhere: (surface: SessionSurface) => void,
  onConnectGithub: () => void
): ReactNode {
  const chatId = surfaceOwner(surface) ?? active.activeChatId
  const paneSession = chatId === active.activeChatId ? active : { ...active, activeChatId: chatId }
  if (surface.kind === "file") {
    return props.renderFiles?.(paneSession, {
      onSelectConversation: () => selectTab(BUILTIN_TAB.conversation),
      onOpenPath: (path) => openSurface({ kind: "file", id: path }),
      path: surface.id,
      onClosed: () => closeEverywhere(surface)
    })
  }
  const contribution =
    surface.kind === "chat" ? conversationContribution : contributions.find((candidate) => candidate.id === surface.id)
  return (
    <>
      <SurfaceContent
        session={active}
        chatId={chatId}
        contribution={contribution}
        paneFocused={focused}
        paneVisible={visible}
        onSelectTab={selectTab}
        onConnectGithub={onConnectGithub}
      />
    </>
  )
}

function allowedViewKeysOf(
  tabs: ReadonlyArray<TabContribution>,
  session: Session,
  planChatIds: ReadonlySet<string>
): ReadonlyArray<string> {
  return tabs.flatMap((contribution) => {
    if (
      contribution.id === BUILTIN_TAB.conversation ||
      contribution.id === BUILTIN_TAB.changes ||
      contribution.id === BUILTIN_TAB.terminal
    ) return []
    if (contribution.id === BUILTIN_TAB.browser) {
      return session.chats.map((chat) => sessionSurfaceKey({ kind: "view", id: contribution.id, chatId: chat.id }))
    }
    if (contribution.id === BUILTIN_TAB.plan) {
      return session.chats
        .filter((chat) => planChatIds.has(chat.id))
        .map((chat) => sessionSurfaceKey({ kind: "view", id: contribution.id, chatId: chat.id }))
    }
    return [sessionSurfaceKey({ kind: "view", id: contribution.id })]
  })
}

function initialEditorLayoutFor(
  sessionId: string,
  fallbackChatId: string,
  mainChatId: string | undefined,
  initialTab: TabKey | undefined
): EditorLayout {
  const held = editorLayoutOf(sessionId)
  if (held) return held
  const restored = loadEditorLayout(sessionId, { kind: "chat", id: fallbackChatId }, mainChatId)
  return initialTab && initialTab !== BUILTIN_TAB.conversation
    ? openTab(restored, { kind: "view", id: initialTab })
    : restored
}

const handleTargetedClose = (
  command: Extract<SessionSurfaceCommand, object>,
  sessionId: string,
  close: (groupId: string, surface: SessionSurface) => void
): void => {
  if (command.sessionId !== sessionId) return
  const current = editorLayoutOf(sessionId)
  const group = current && groupsOf(current.root).find((candidate) =>
    candidate.tabs.some((surface) => sessionSurfaceKey(surface) === sessionSurfaceKey(command.surface))
  )
  if (group) close(group.id, command.surface)
}

const handleSurfaceCommand = (
  command: SessionSurfaceCommand,
  sessionId: string,
  update: (fn: (current: EditorLayout) => EditorLayout) => void,
  syncChat: (surface: SessionSurface) => void,
  close: (groupId: string, surface: SessionSurface) => void
): void => {
  if (typeof command === "object") {
    handleTargetedClose(command, sessionId, close)
    return
  }
  const current = editorLayoutOf(sessionId)
  if (!current) return
  if (command === "close") {
    const group = focusedGroup(current)
    if (group) close(group.id, activeSurface(group))
    return
  }
  const next = applyEditorCommand(current, command)
  update(() => next)
  const nextGroup = focusedGroup(next)
  if (nextGroup) syncChat(activeSurface(nextGroup))
}

// One component coordinates independent tab, browser, plan, and persistence effects.
// oxlint-disable eslint/complexity
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: splitting the coordinator would duplicate those effects.
function SessionPaneBody(props: SessionPaneProps) {

  const active = props.session
  const sessionId = active.id
  // The host's hook is a fixed prop for the app's lifetime, so the call order is stable.
  const terminals = props.useSessionTerminals?.(active)
  const terminalsRef = useRef(terminals)
  terminalsRef.current = terminals
  const shells = terminals?.tabs ?? NO_SHELLS
  const mainChatId = active.chats[0]?.id
  const fallbackChatSurface: SessionSurface = { kind: "chat", id: active.activeChatId }
  const [headerViewsTarget, setHeaderViewsTarget] = useState<HTMLElement | null>(null)
  const [headerIdentityTarget, setHeaderIdentityTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    setHeaderViewsTarget(document.getElementById("session-header-views-portal"))
    setHeaderIdentityTarget(document.getElementById("session-header-identity-portal"))
  }, [])

  // The layout lives in the app-wide store so the sidebar tree reads the same
  // one. The first mount seeds it from storage; later mounts reuse what is held.
  // Keyed on the session alone: an unkeyed pane can swap sessions, and each
  // session must seed (or reuse) its own layout.
  const initialLayout = useMemo<EditorLayout>(
    () => initialEditorLayoutFor(sessionId, active.activeChatId, mainChatId, props.initialTab),
    [active.activeChatId, mainChatId, props.initialTab, sessionId]
  )
  useLayoutEffect(() => initEditorLayout(sessionId, initialLayout), [sessionId, initialLayout])
  const layout = useEditorLayout(sessionId) ?? initialLayout
  // Chat lane mode: collapsed shows the Ask pill; Focus hides (but keeps mounted) the content tabs.
  const [laneHost, setLaneHost] = useState<HTMLDivElement | null>(null)
  const chatLane = useChatLane(allTabs(layout).some((tab) => tab.kind !== "chat"))
  const update = useCallback(
    (fn: (current: EditorLayout) => EditorLayout) => updateEditorLayout(sessionId, fn),
    [sessionId]
  )
  const focused = focusedGroup(layout)
  const focusedSurface = focused ? activeSurface(focused) : fallbackChatSurface
  /** A chat-owned surface the operator acts on makes its chat the session's active one. */
  const syncChat = useCallback((surface: SessionSurface) => {
    const chatId = surfaceOwner(surface)
    if (chatId && chatId !== active.activeChatId) props.onFocusChat?.(sessionId, chatId)
  }, [active.activeChatId, props.onFocusChat, sessionId])
  const openSurface = useCallback(
    (surface: SessionSurface) => {
      update((current) => openTab(current, surface, mainChatId))
      syncChat(surface)
    },
    [mainChatId, syncChat, update]
  )
  const shellsHydrated = terminals?.hydrated ?? true
  /** Spawns a shell and opens its tab. */
  const openNewShell = useCallback(async () => {
    const id = await terminalsRef.current?.create()
    if (id) openSurface({ kind: "terminal", id })
  }, [openSurface])
  /** ⌃`, the palette and "Open in terminal": the newest shell, or a fresh one if none. */
  const [shellWanted, setShellWanted] = useState(false)
  const openLatestShell = useCallback(() => {
    const latest = terminalsRef.current?.tabs.at(-1)
    if (latest) openSurface({ kind: "terminal", id: latest.id })
    else void openNewShell()
  }, [openNewShell, openSurface])
  useEffect(() => {
    if (!shellWanted || !shellsHydrated) return
    setShellWanted(false)
    openLatestShell()
  }, [shellWanted, shellsHydrated, openLatestShell])
  const restartShell = useCallback(async (id: string) => {
    const next = await terminalsRef.current?.restart(id)
    if (next) openSurface({ kind: "terminal", id: next })
  }, [openSurface])

  const filePaths = allTabs(layout)
    .flatMap((surface) => (surface.kind === "file" ? [surface.id] : []))
    .join("\n")
  useEffect(() => {
    if (!filePaths) return
    for (const path of filePaths.split("\n")) props.onTrackFile?.(sessionId, path)
  }, [filePaths, props.onTrackFile, sessionId])


  // A pending deep link into Plan Review. One-shot: Plan Review reports its own
  // selection back and we drop it. Tagged with its session because step ids
  // (s_01, s_02…) collide across sessions.
  const [target, setTarget] = useState<{ sessionId: string; chatId: string; stepId: string } | null>(null)
  const pendingPlanOpen = useRef<string | null>(null)
  const activeHasPlan =
    (props.planSessions?.has(active.activeChatId) ?? false) ||
    pendingPlanOpen.current === active.activeChatId
  const hasPlan =
    active.chats.some((chat) => props.planSessions?.has(chat.id) ?? false) ||
    pendingPlanOpen.current !== null
  const previousOwner = useRef({ sessionId, chatId: active.activeChatId })
  useEffect(() => {
    const previous = previousOwner.current
    if (previous.sessionId === sessionId && previous.chatId !== active.activeChatId) {
      if (surfaceOwner(focusedSurface) !== active.activeChatId) {
        openSurface({ kind: "chat", id: active.activeChatId })
        setTarget(null)
      }
    }
    previousOwner.current = { sessionId, chatId: active.activeChatId }
  }, [active.activeChatId, focusedSurface, openSurface, sessionId])
  const hasExplanation = props.explanationSessions?.has(sessionId) ?? false
  const openPlanReviewFor = useCallback(
    (chatId: string, stepId?: string) => {
      setTarget(stepId ? { sessionId, chatId, stepId } : null)
      openSurface({ kind: "view", id: BUILTIN_TAB.plan, chatId })
    },
    [openSurface, sessionId]
  )
  const openPlanReview = useCallback(
    (stepId?: string) => openPlanReviewFor(active.activeChatId, stepId),
    [active.activeChatId, openPlanReviewFor]
  )
  const presentPlanDraftFor = useCallback((chatId: string) => {
    pendingPlanOpen.current = chatId
    setTarget(null)
    openSurface({ kind: "view", id: BUILTIN_TAB.plan, chatId })
  }, [openSurface])
  const dismissPlanDraftFor = useCallback((chatId: string) => {
    if (pendingPlanOpen.current !== chatId || props.planSessions?.has(chatId)) return
    pendingPlanOpen.current = null
    setTarget(null)
    update((current) => closeSurfaceEverywhere(current, { kind: "view", id: BUILTIN_TAB.plan, chatId }))
  }, [props.planSessions, update])
  useEffect(() => {
    const pending = pendingPlanOpen.current
    if (pending === null || !props.planSessions?.has(pending)) return
    pendingPlanOpen.current = null
    openSurface({ kind: "view", id: BUILTIN_TAB.plan, chatId: pending })
  }, [openSurface, props.planSessions])

  const browserActive = props.isBrowserActive?.(sessionId, active.activeChatId) ?? false
  const previousBrowser = useRef({ chatId: active.activeChatId, active: browserActive })
  useEffect(() => {
    const previous = previousBrowser.current
    previousBrowser.current = { chatId: active.activeChatId, active: browserActive }
    if (previous.chatId !== active.activeChatId) return
    const surface: SessionSurface = { kind: "view", id: BUILTIN_TAB.browser, chatId: active.activeChatId }
    if (browserActive && !previous.active) openSurface(surface)
    if (!browserActive && previous.active) update((current) => closeSurfaceEverywhere(current, surface))
  }, [active.activeChatId, browserActive, openSurface, update])

  function selectTabIssue(nextTab: TabKey) {
    const providerId = props.tabContributions?.find((contribution) => contribution.id === nextTab)?.issueProviderId
    const current = issueReferenceOf(active)
    if (!providerId || current?.providerId === providerId) return
    const issue = issueReferencesOf(active).find((candidate) => candidate.providerId === providerId)
    if (!issue) return
    props.onSelectIssue?.(active.id, {
      providerId: issue.providerId,
      ...(issue.providerAccountId ? { providerAccountId: issue.providerAccountId } : {}),
      id: issue.id
    })
  }

  // Changes (and the retired Code Review tab) are reviewed in the Explorer, so
  // selecting them is an action on the host rather than a surface to open.
  const onRevealChanges = props.onRevealChanges
  const selectView = useCallback(
    (nextTab: TabKey) => {
      if (nextTab === BUILTIN_TAB.changes || nextTab === BUILTIN_TAB.review) {
        onRevealChanges?.(active.id)
        return
      }
      selectTabIssue(nextTab)
      if (nextTab === BUILTIN_TAB.plan) return openPlanReview()
      if (nextTab === BUILTIN_TAB.conversation) return openSurface({ kind: "chat", id: active.activeChatId })
      if (nextTab === BUILTIN_TAB.browser && !browserActive) props.onToggleBrowser?.(active.id, active.activeChatId)
      openSurface({
        kind: "view",
        id: nextTab,
        ...(nextTab === BUILTIN_TAB.browser ? { chatId: active.activeChatId } : {})
      })
    },
    [active, browserActive, onRevealChanges, openPlanReview, openSurface, props.onToggleBrowser, props.tabContributions]
  )
  const selectTab = useCallback(
    (nextTab: TabKey) =>
      nextTab === BUILTIN_TAB.terminal
        ? shellsHydrated ? openLatestShell() : setShellWanted(true)
        : selectView(nextTab),
    [openLatestShell, selectView, shellsHydrated]
  )
  // An outside request to switch tabs (the command palette). The nonce is the
  // trigger, and reporting it handled stops a remount replaying it. It goes
  // through selectTab, exactly like the header buttons.
  const tabRequestNonce = props.selectTabRequest?.nonce
  const tabRequestId = props.selectTabRequest?.tabId
  const onTabRequestHandled = props.onTabRequestHandled
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce is the one-shot trigger; see the prop contract.
  useEffect(() => {
    if (tabRequestId === undefined) return
    selectTab(tabRequestId)
    onTabRequestHandled?.()
  }, [tabRequestNonce])
  const tabCtx: TabContext = {
    session: active,
    hasPlan,
    hasExplanation,
    diff: props.liveDiff?.[active.id] ?? null,
    checkCounts: props.prStates?.[active.id]?.checkCounts ?? null
  }
  const connectGithub = props.onOpenSettings ?? noop

  const contributions = useMemo<ReadonlyArray<TabContribution>>(() => [
    ...builtinTabContributions({
      conversation: (session, ctx) => {
        const paneCtx: ConversationPaneCtx = {
          onOpenPlanReview: (stepId) => openPlanReviewFor(session.activeChatId, stepId),
          onOpenFile: (path) => {
            props.onTrackFile?.(session.id, path)
            openSurface({ kind: "file", id: path })
          },

          onSelectBrowser: () => ctx.onSelectTab(BUILTIN_TAB.browser),
          onSelectChanges: () => ctx.onSelectTab(BUILTIN_TAB.changes),
          onOpenPullRequest: () => ctx.onSelectTab(BUILTIN_TAB.checks),
          onOpenProviderSettings: props.onOpenProviderSettings ?? connectGithub,
          onPlanDraftAvailable: () => presentPlanDraftFor(session.activeChatId),
          onPlanDraftUnavailable: () => dismissPlanDraftFor(session.activeChatId),
          planStepId:
            target?.sessionId === session.id && target.chatId === session.activeChatId
              ? target.stepId
              : null,
          onPlanStepSelected: () => setTarget(null),
          paneFocused: ctx.paneFocused ?? true
        }
        if (!props.renderConversation) {
          return props.conversationPane ?? <ConversationView messages={SEED_CONVERSATION} mode="accept-edits" />
        }
        return props.renderConversation(
          session,
          ctx.activeTabId === BUILTIN_TAB.plan ? "plan" : "conversation",
          paneCtx
        )
      },
      explanation: (session) => props.renderExplanation?.(session),
      pullRequest: (session, ctx) =>
        props.renderPullRequest?.(session, {
          onConnectGithub: ctx.onConnectGithub,
          onSelectReview: () => ctx.onSelectTab(BUILTIN_TAB.changes)
        }),
      browser: (session, ctx) => props.renderBrowser?.(session, ctx.paneVisible ?? true),
      terminal: () => null,
      stub: (id) => <BuiltinStubScreen tab={id} />
    }),
    ...(props.tabContributions ?? [])
  ], [props, dismissPlanDraftFor, openPlanReviewFor, presentPlanDraftFor, target, connectGithub])

  const tabs = visibleTabs(tabCtx, contributions)
  const planChatIds = new Set(
    active.chats
      .map((chat) => chat.id)
      .filter((chatId) => props.planSessions?.has(chatId) || pendingPlanOpen.current === chatId)
  )
  const allowedViewKeys = allowedViewKeysOf(tabs, active, planChatIds)
  const allowedSurfaceKeys = new Set<string>([
    ...active.chats.map((chat) => sessionSurfaceKey({ kind: "chat", id: chat.id })),
    ...allTabs(layout).filter((surface) => surface.kind === "file").map(sessionSurfaceKey),
    ...allowedViewKeys,
    // Until the shell list loads, keep restored shell tabs and the old Terminal view for migration.
    ...(shellsHydrated
      ? shells.map((shell) => sessionSurfaceKey({ kind: "terminal", id: shell.id }))
      : [
          sessionSurfaceKey({ kind: "view", id: BUILTIN_TAB.terminal }),
          ...allTabs(layout).filter((surface) => surface.kind === "terminal").map(sessionSurfaceKey)
        ])
  ])
  const allowedSurfaceSignature = [...allowedSurfaceKeys].sort().join("\n")
  // A persisted Terminal view tab becomes the session's shell tabs once they are known.
  useEffect(() => {
    if (!shellsHydrated) return
    update((current) => replaceLegacyTerminalView(current, shells.map((shell) => ({ kind: "terminal", id: shell.id }))))
  }, [shellsHydrated, shells, update])
  useEffect(() => {
    update((current) => pruneEditorLayout(current, allowedSurfaceKeys))
  }, [allowedSurfaceSignature, update])

  // Never leave a hidden tab selected (a merged PR, a disabled plugin).
  const activeTab = resolveVisibleTab(tabs, tabOf(focusedSurface))
  const conversationContribution = tabs.find((c) => c.id === BUILTIN_TAB.conversation)
  useEffect(() => {
    props.onActiveTabChange?.(active.id, activeTab)
  }, [active.id, activeTab, props.onActiveTabChange])

  // Chats are tabs reached from the host's chat navigation; stories without it
  // keep Conversation in the rail so the transcript stays reachable.
  const railTabs = tabs
    .filter(
      (contribution) =>
        (contribution.id !== BUILTIN_TAB.plan || activeHasPlan) &&
        contribution.id !== BUILTIN_TAB.conversation
    )
    .map((contribution) => describeTab(contribution, tabCtx))

  

  const closeTabIn = useCallback(
    (groupId: string, surface: SessionSurface) => {
      const current = editorLayoutOf(sessionId) ?? layout
      const key = sessionSurfaceKey(surface)
      const copies = groupsOf(current.root).filter((group) => group.tabs.some((tab) => sessionSurfaceKey(tab) === key)).length
      if (
        surface.kind === "file" &&
        copies <= 1 &&
        props.onRequestCloseFile &&
        !props.onRequestCloseFile(active.id, surface.id)
      ) {
        // The editor's discard prompt owns the decision; keep its tab in view.
        update((held) => activateTab(held, groupId, key))
        return
      }
      discardUntouchedChat(surface, copies, active.id, props.onCloseUntouchedChat)
      killShell(surface, copies, terminalsRef.current)
      if (surface.kind === "view" && surface.id === BUILTIN_TAB.browser && copies <= 1) {
        const chatId = surface.chatId ?? active.activeChatId
        if (props.isBrowserActive?.(active.id, chatId)) props.onToggleBrowser?.(active.id, chatId)
      }
      const next = closeTab(current, groupId, surface)
      update(() => next)
      const nextGroup = focusedGroup(next)
      if (nextGroup) syncChat(activeSurface(nextGroup))
    },
    [active.activeChatId, active.id, layout, props.isBrowserActive, props.onCloseUntouchedChat, props.onRequestCloseFile, props.onToggleBrowser, sessionId, syncChat, update]
  )

  const [pendingPlanClose, setPendingPlanClose] = useState<{ groupId: string; surface: SessionSurface; count: number } | null>(null)
  const requestCloseTab = useCallback(
    (groupId: string, surface: SessionSurface) => {
      const count = surface.kind === "view" && surface.id === BUILTIN_TAB.plan
        ? planDraftCount(planDraftKey(active.id, surface.chatId ?? active.activeChatId))
        : 0
      if (count > 0) setPendingPlanClose({ groupId, surface, count })
      else closeTabIn(groupId, surface)
    },
    [active.activeChatId, active.id, closeTabIn]
  )

  const launcherTabs = tabs.some((contribution) => contribution.id === BUILTIN_TAB.plan)
    ? tabs
    : [...tabs, contributions.find((contribution) => contribution.id === BUILTIN_TAB.plan)!]
  const viewLauncherItems: ReadonlyArray<TabLauncherItem> = launcherTabs
    .map((contribution) => describeTab(contribution, tabCtx))
    .toSorted((left, right) => {
      const priority = (id: TabKey) => (id === BUILTIN_TAB.browser ? 0 : id === BUILTIN_TAB.terminal ? 1 : 2)
      return priority(left.id) - priority(right.id)
    })
    .filter(
      (descriptor) =>
        descriptor.id !== BUILTIN_TAB.conversation &&
        descriptor.id !== BUILTIN_TAB.files
    )
    .map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      icon: descriptor.icon,
      ...(descriptor.id === BUILTIN_TAB.terminal ? { detail: "Open a shell in this worktree" } : {}),
      onSelect: () => (descriptor.id === BUILTIN_TAB.terminal ? void openNewShell() : selectTab(descriptor.id))
    }))
  const launcherItems: ReadonlyArray<TabLauncherItem> = [
    ...(props.onCreateChat
      ? [{ id: "chat", label: "Chat", detail: "Start a new conversation", icon: MessageSquarePlus, onSelect: () => props.onCreateChat?.(sessionId) }]
      : []),
    ...(props.onOpenFilePicker && activeCheckoutOf(active).worktreePath
      ? [{ id: "file", label: "File", detail: "Open a repository file", icon: File, onSelect: () => props.onOpenFilePicker?.(sessionId) }]
      : []),
    ...viewLauncherItems
  ]

  const describeSurface = (surface: SessionSurface) => describeEditorSurface(surface, active, contributions, tabCtx, shells)

  const renderBody = (surface: SessionSurface, ctx: { readonly focused: boolean; readonly visible: boolean }) =>
    surface.kind === "terminal"
      ? renderShell(terminals, surface.id, ctx.visible, restartShell)
      : renderEditorBody(
      props,
      active,
      surface,
      ctx.focused,
      ctx.visible,
      conversationContribution,
      contributions,
      selectTab,
      openSurface,
      (target) => update((current) => closeSurfaceEverywhere(current, target)),
      connectGithub
    )

  const renderRevision = useMemo(() => ({}), [active, contributions, shells])
  const paneFocused = props.pane === undefined || props.pane.focused
  // Keyboard shortcuts for chat lane collapse (⌘L) and Focus mode (⌘⇧L)
  useEffect(() => {
    if (!paneFocused) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchCollapseChatChord(e)) {
        e.preventDefault()
        chatLane.toggleCollapse()
      } else if (matchFocusChatChord(e)) {
        e.preventDefault()
        chatLane.toggleFocus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [paneFocused, chatLane])
  useEffect(() => {
    if (!paneFocused) return
    const onCommand = (event: Event) => handleSurfaceCommand(
      (event as CustomEvent<SessionSurfaceCommand>).detail,
      sessionId,
      update,
      syncChat,
      requestCloseTab
    )
    window.addEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
  }, [requestCloseTab, paneFocused, sessionId, syncChat, update])

  const surfaceInGroup = (groupId: string): SessionSurface | undefined => {
    const group = groupsOf((editorLayoutOf(sessionId) ?? layout).root).find((g) => g.id === groupId)
    return group && activeSurface(group)
  }

  const headerItems: ReadonlyArray<HeaderViewItem> = railTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    ...(tab.id === BUILTIN_TAB.checks ? { shortcut: "mod+shift+p" } : tab.id === BUILTIN_TAB.changes ? { shortcut: "mod+shift+d" } : tab.id === BUILTIN_TAB.browser ? { shortcut: "mod+shift+b" } : {}),
    ...(tab.badge?.kind === "count" ? { count: tab.badge.text } : {}),
    ...(tab.badge?.kind === "diff" ? { count: `+${tab.badge.added} −${tab.badge.removed}` } : {}),
    ...(props.tabContributions?.some((contribution) => contribution.id === tab.id) ? { plugin: true } : {})
  }))
  const pinnedViews = props.headerViews ?? []
  const pinnedHeaderItems = pinnedViews.flatMap((id) => headerItems.filter((item) => item.id === id))
  // ⌘⇧D opens Changes; ⌘⇧P opens Checks; ⌥1–⌥9 open the header button at that position. Both go through
  // selectTab, exactly like clicking the button. ⌃` and ⌘⇧B are routed by JinglerApp.
  const hasChecks = tabs.some((tab) => tab.id === BUILTIN_TAB.checks)
  useEffect(() => {
    if (!paneFocused) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = viewChordTarget(e, hasChecks, pinnedHeaderItems)
      if (target === undefined) return
      e.preventDefault()
      selectTab(target)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [paneFocused, hasChecks, pinnedHeaderItems, selectTab])
  // Context links (spec §3c): the PR and the linked issue open their view through selectTab.
  const linkChips: HeaderLinkChip[] = []
  if (active.prNumber != null && tabs.some((tab) => tab.id === BUILTIN_TAB.checks)) {
    linkChips.push({
      id: "pr",
      label: `PR #${active.prNumber}`,
      title: "Open pull request",
      icon: GitPullRequest,
      onOpen: () => selectTab(BUILTIN_TAB.checks)
    })
  }
  const prRows = sessionPrRows(
    [
      ...(active.prs?.length ? active.prs.map((pr) => pr.number) : active.prNumber == null ? [] : [active.prNumber]),
      ...(active.linkedPrs ?? [])
    ],
    props.subagentPrNodes?.[active.id] ?? [],
    new Map((active.prs ?? []).flatMap((pr) => (pr.repo === undefined ? [] : [[pr.number, pr.repo] as const])))
  )
  const linkedIssue = issueReferenceOf(active)
  const issueTab = tabs.find((tab) => linkedIssue !== undefined && tab.issueProviderId === linkedIssue.providerId)
  if (linkedIssue && issueTab) {
    linkChips.push({
      id: "issue",
      label: linkedIssue.identifier,
      title: `Open ${linkedIssue.identifier}`,
      icon: CircleDot,
      onOpen: () => selectTab(issueTab.id)
    })
  }
  const issueMenu =
    props.issueMenus?.[activeTab] ?? buildIssueMenu(active, tabs.find((c) => c.id === activeTab), props.onSelectIssue)
  const issuePicker = issueMenu ? (
    <LinkedIssueSelector
      items={issueMenu.items}
      value={issueMenu.value}
      onValueChange={issueMenu.onSelect}
      variant="compact"
      ariaLabel={issueMenu.ariaLabel}
      className="max-w-[160px]"
    />
  ) : null
  const viewButtons =
    props.headerViews !== undefined && props.onHeaderViewsChange ? (
      <>
        <HeaderViewButtons
          views={pinnedHeaderItems}
          activeId={activeTab}
          onOpen={selectTab}
        />
        <ViewOverflowMenu views={headerItems} pinned={pinnedViews} onOpen={selectTab} onPinnedChange={props.onHeaderViewsChange} />
      </>
    ) : null
  const headerViewControls =
    issuePicker || viewButtons ? (
      <div className="flex items-center gap-0.5">
        {issuePicker}
        {viewButtons}
      </div>
    ) : null
  const headerIdentity = (
    <SessionHeaderIdentity
      title={active.title || UNTITLED_SESSION}
      branch={activeCheckoutOf(active).branch}
      chips={prRows.length > 1 ? linkChips.filter((chip) => chip.id !== "pr") : linkChips}
    >
      {prRows.length > 1 && (
        <SessionPrsChip
          rows={prRows}
          onSelect={(row) => {
            props.onOpenSessionPr?.(active.id, row.number)
            selectTab(BUILTIN_TAB.checks)
          }}
        />
      )}
    </SessionHeaderIdentity>
  )

  const renderGroups = (groupLayout: EditorLayout) => (
        <EditorGroups
          onOpenCheckpoints={props.onOpenCheckpoints ? (trigger) => props.onOpenCheckpoints?.(sessionId, trigger) : undefined}
          sessionId={sessionId}
          layout={groupLayout}
          // Layout-only updates keep this token, while render dependencies replace it.
          revision={renderRevision}
          describe={describeSurface}
          renderBody={(surface, ctx) => renderBody(surface, { ...ctx, visible: ctx.visible && !chatLane.contentHidden })}
          onActivate={(groupId, surface) => {
            update((current) => activateTab(current, groupId, sessionSurfaceKey(surface)))
            if (surface.kind === "chat") props.onFocusChat?.(sessionId, surface.id)
            else syncChat(surface)
          }}
          onClose={requestCloseTab}
          onDrop={(drag, groupId, edge, copy) => {
            update((current) => dropTab(current, drag, groupId, edge, copy, mainChatId))
            syncChat(drag.surface)
          }}
          onFocusGroup={(groupId) => {
            update((current) => focusEditorGroup(current, groupId))
            const surface = surfaceInGroup(groupId)
            if (surface) syncChat(surface)
          }}
          onResize={(splitId, index, delta, containerWidth) => {
            if (wouldCollapseChatLane(layout, splitId, index, delta, containerWidth)) chatLane.toggleCollapse()
            else update((current) => resizeSplit(current, splitId, index, delta, containerWidth))
          }}
          launcherItems={launcherItems}
          onCreateChat={props.onCreateChat}
          followAgent={props.followAgent}
          onToggleFollowAgent={props.onToggleFollowAgent}
          renderSubagentChip={(chatId) =>
            props.renderSubagentTabs?.(chatId === active.activeChatId ? active : { ...active, activeChatId: chatId }, {
              activeTabId: BUILTIN_TAB.conversation,
              onSelectConversation: () => openSurface({ kind: "chat", id: chatId })
            })}
        />
  )
  const drawerLane = chatLane.mode === "drawer" ? chatLaneOnly(layout) : null
  const contentLayout = chatLane.showAskPill || chatLane.mode === "drawer" ? withoutChatLane(layout) : layout

  return (
    <>
      {headerIdentityTarget !== null && paneFocused ? createPortal(headerIdentity, headerIdentityTarget) : null}
      {headerViewsTarget !== null && paneFocused && headerViewControls ? createPortal(headerViewControls, headerViewsTarget) : null}
      <div ref={setLaneHost} className="flex min-h-0 min-w-0 flex-1 flex-row relative">
        {(chatLane.showAskPill || drawerLane) && (
          <AskPill
            onClick={() => chatLane.toggleCollapse()}
            className="absolute bottom-4 left-4 z-10"
          />
        )}
        {renderGroups(contentLayout)}
        {drawerLane && laneHost && (
          <ChatDrawer open={chatLane.drawerOpen} onOpenChange={(open) => open !== chatLane.drawerOpen && chatLane.toggleCollapse()} container={laneHost}>
            {renderGroups(drawerLane)}
          </ChatDrawer>
        )}
        {props.renderReviewTray?.(active, { onConnectGithub: connectGithub })}
      </div>
      <DiscardCommentsDialog
        open={pendingPlanClose !== null}
        count={pendingPlanClose?.count ?? 0}
        onOpenChange={(open) => { if (!open) setPendingPlanClose(null) }}
        onDiscard={() => { if (pendingPlanClose) closeTabIn(pendingPlanClose.groupId, pendingPlanClose.surface) }}
      />
    </>
  )
}
