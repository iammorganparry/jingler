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
  SessionActivity
} from "@jingler/core"
import {
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
import { ViewRail, type ViewRailMenu } from "../app/view-rail.js"
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
  closeSurfaceEverywhere,
  closeTab,
  dropTab,
  focusEditorGroup,
  focusedGroup,
  groupsOf,
  loadEditorLayout,
  openTab,
  pruneEditorLayout,
  resizeSplit,
  type EditorLayout
} from "../app/editor-layout.js"
import {
  editorLayoutOf,
  initEditorLayout,
  updateEditorLayout,
  useEditorLayout
} from "../app/editor-layout-machine.js"
import { EditorGroups, type EditorTabMeta } from "../app/editor-groups.js"
import type { TabLauncherItem } from "../app/chat-tab-bar.js"
import { File, MessageSquarePlus, MessagesSquare } from "lucide-react"

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
  /** Present the Files workspace without requiring a path to be selected. */
  onSelectFiles: () => void
  /** Present canonical worktree changes for mutation recovery inspection. */
  onSelectChanges: () => void
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

export interface SessionChatTabsRenderContext {
  readonly activeTabId: TabKey
  readonly onSelectConversation: () => void
  readonly onSelectFiles: () => void
  readonly activeSurface?: SessionSurface
  readonly onSelectSurface?: (surface: SessionSurface) => void
  readonly onCloseSurface?: (surface: SessionSurface) => void
  readonly onRequestCloseFile?: (path: string) => boolean
  readonly viewSlot?: ReactNode
  readonly viewCount?: number
  readonly viewsActive?: boolean
  readonly onCloseAllViews?: () => void
  readonly viewLauncherItems?: ReadonlyArray<TabLauncherItem>
  readonly paneFocused?: boolean
}

export interface SessionPaneProps {
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
  /** Render the session terminal as a normal closable/splittable view. */
  renderTerminal?: (session: Session, visible: boolean) => ReactNode
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
  /**
   * Render the session's chat pills into the tab row's `chatSlot` (behind the
   * divider). A render prop for the same reason `renderConversation` is: the
   * chat state it drives — the create/select/rename/close RPCs and the live
   * per-chat activity — lives in the desktop renderer, so building the bar here
   * would drag the RPC client into the component library. Absent in stories.
   */
  renderChatTabs?: (
    session: Session,
    ctx: SessionChatTabsRenderContext
  ) => ReactNode
  /** Render children of the selected top-level agent in a second tab row. */
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
  /** Open the repository file picker for this session (the "+" menu's File entry). */
  onOpenFilePicker?: (sessionId: string) => void
  /** Persist selection of a provider-scoped issue from the right view rail. */
  onSelectIssue?: (sessionId: string, issue: IssueIdentity) => void
  /** Optional pickers anchored to right-rail view icons, keyed by tab id. */
  viewRailMenus?: Readonly<Record<TabKey, ViewRailMenu | undefined>>
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
    : surface.kind === "file"
      ? BUILTIN_TAB.files
      : BUILTIN_TAB.conversation

function buildProviderMenus(
  session: Session,
  tabs: ReadonlyArray<TabContribution>,
  onSelectIssue: SessionPaneProps["onSelectIssue"]
): Record<TabKey, ViewRailMenu | undefined> {
  const providerMenus: Record<TabKey, ViewRailMenu | undefined> = {}
  if (!onSelectIssue) return providerMenus
  const selectedIssue = issueReferenceOf(session)
  for (const contribution of tabs) {
    const providerId = contribution.issueProviderId
    if (!providerId) continue
    const issues = issueReferencesOf(session).filter((issue) => issue.providerId === providerId)
    if (issues.length < 2) continue
    const selected = selectedIssue?.providerId === providerId ? selectedIssue : issues[0]!
    providerMenus[contribution.id] = {
      value: issueMenuValue(selected),
      ariaLabel: `Select linked ${providerId[0]?.toUpperCase() ?? ""}${providerId.slice(1)} issue`,
      options: issues.map((issue) => ({
        value: issueMenuValue(issue),
        label: issue.identifier,
        description: issue.title,
        ariaLabel: `${issue.identifier} ${issue.title}`,
        searchText: `${issue.identifier} ${issue.title}`
      })),
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
  return providerMenus
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
  tabCtx: TabContext
): EditorTabMeta {
  const sessionLabel = session.title || UNTITLED_SESSION
  if (surface.kind === "chat") {
    const label = chatTitleOf(session, surface.id)
    return { label, icon: MessagesSquare, crumbs: [sessionLabel, label] }
  }
  if (surface.kind === "file") {
    return { label: surface.id.split("/").at(-1) ?? surface.id, crumbs: [sessionLabel, session.branch, surface.id] }
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
      {surface.kind === "chat" &&
        props.renderSubagentTabs?.(paneSession, {
          activeTabId: BUILTIN_TAB.conversation,
          onSelectConversation: () => openSurface(surface)
        })}
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
      contribution.id === BUILTIN_TAB.files ||
      contribution.id === BUILTIN_TAB.changes
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

// One component coordinates independent tab, browser, plan, and persistence effects.
// oxlint-disable eslint/complexity
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: splitting the coordinator would duplicate those effects.
function SessionPaneBody(props: SessionPaneProps) {
  const active = props.session
  const sessionId = active.id
  const mainChatId = active.chats[0]?.id
  const fallbackChatSurface: SessionSurface = { kind: "chat", id: active.activeChatId }
  const [viewRailTarget, setViewRailTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    setViewRailTarget(document.getElementById("session-view-rail-portal"))
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

  const filePaths = allTabs(layout)
    .flatMap((surface) => (surface.kind === "file" ? [surface.id] : []))
    .join("\n")
  useEffect(() => {
    if (!filePaths) return
    for (const path of filePaths.split("\n")) props.onTrackFile?.(sessionId, path)
  }, [filePaths, props.onTrackFile, sessionId])

  const lastDebugStop = useRef(0)
  useEffect(() => {
    const sequence = props.debugStopSequence ?? 0
    if (sequence > 0 && sequence !== lastDebugStop.current) {
      openSurface({ kind: "view", id: BUILTIN_TAB.files })
    }
    lastDebugStop.current = sequence
  }, [openSurface, props.debugStopSequence])

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

  // An outside request to switch tabs (the command palette). The nonce is the
  // trigger, and reporting it handled stops a remount replaying it.
  const tabRequestNonce = props.selectTabRequest?.nonce
  const tabRequestId = props.selectTabRequest?.tabId
  const onTabRequestHandled = props.onTabRequestHandled
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce is the one-shot trigger; see the prop contract.
  useEffect(() => {
    if (tabRequestId === undefined) return
    if (tabRequestId === BUILTIN_TAB.plan) openPlanReview()
    else if (tabRequestId === BUILTIN_TAB.conversation) openSurface({ kind: "chat", id: active.activeChatId })
    else {
      if (tabRequestId === BUILTIN_TAB.browser && !props.isBrowserActive?.(sessionId, active.activeChatId)) {
        props.onToggleBrowser?.(sessionId, active.activeChatId)
      }
      openSurface({
        kind: "view",
        id: tabRequestId,
        ...(tabRequestId === BUILTIN_TAB.browser ? { chatId: active.activeChatId } : {})
      })
    }
    onTabRequestHandled?.()
  }, [tabRequestNonce])

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
  const selectTab = useCallback(
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
  const tabCtx: TabContext = {
    session: active,
    hasPlan,
    hasExplanation,
    diff: props.liveDiff?.[active.id] ?? null
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
          onSelectFiles: () => ctx.onSelectTab(BUILTIN_TAB.files),
          onSelectChanges: () => ctx.onSelectTab(BUILTIN_TAB.changes),
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
      files: (session, ctx) =>
        props.renderFiles?.(session, {
          onSelectConversation: () => ctx.onSelectTab(BUILTIN_TAB.conversation),
          onOpenPath: (path) => openSurface({ kind: "file", id: path })
        }),
      browser: (session, ctx) => props.renderBrowser?.(session, ctx.paneVisible ?? true),
      terminal: (session, ctx) => props.renderTerminal?.(session, ctx.paneVisible ?? true),
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
    ...(active.worktreePath ? [sessionSurfaceKey({ kind: "view", id: BUILTIN_TAB.files })] : []),
    ...allTabs(layout).filter((surface) => surface.kind === "file").map(sessionSurfaceKey),
    ...allowedViewKeys
  ])
  const allowedSurfaceSignature = [...allowedSurfaceKeys].sort().join("\n")
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
        (props.renderChatTabs === undefined || contribution.id !== BUILTIN_TAB.conversation)
    )
    .map((contribution) => describeTab(contribution, tabCtx))
  const viewRailMenus = { ...buildProviderMenus(active, tabs, props.onSelectIssue), ...props.viewRailMenus }

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
      if (surface.kind === "view" && surface.id === BUILTIN_TAB.browser && copies <= 1) {
        const chatId = surface.chatId ?? active.activeChatId
        if (props.isBrowserActive?.(active.id, chatId)) props.onToggleBrowser?.(active.id, chatId)
      }
      const next = closeTab(current, groupId, surface)
      update(() => next)
      const nextGroup = focusedGroup(next)
      if (nextGroup) syncChat(activeSurface(nextGroup))
    },
    [active.activeChatId, active.id, layout, props.isBrowserActive, props.onRequestCloseFile, props.onToggleBrowser, sessionId, syncChat, update]
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
      onSelect: () => selectTab(descriptor.id)
    }))
  const launcherItems: ReadonlyArray<TabLauncherItem> = [
    ...(props.onCreateChat
      ? [{ id: "chat", label: "Chat", detail: "Start a new conversation", icon: MessageSquarePlus, onSelect: () => props.onCreateChat?.(sessionId) }]
      : []),
    ...(props.onOpenFilePicker && active.worktreePath
      ? [{ id: "file", label: "File", detail: "Open a repository file", icon: File, onSelect: () => props.onOpenFilePicker?.(sessionId) }]
      : []),
    ...viewLauncherItems
  ]

  const describeSurface = (surface: SessionSurface) => describeEditorSurface(surface, active, contributions, tabCtx)

  const renderBody = (surface: SessionSurface, ctx: { readonly focused: boolean; readonly visible: boolean }) =>
    renderEditorBody(
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

  const renderRevision = useMemo(() => ({}), [active, contributions])
  const paneFocused = props.pane === undefined || props.pane.focused
  useEffect(() => {
    if (!paneFocused) return
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<SessionSurfaceCommand>).detail
      if (command !== "close") {
        const current = editorLayoutOf(sessionId)
        if (!current) return
        const next = applyEditorCommand(current, command)
        update(() => next)
        const nextGroup = focusedGroup(next)
        if (nextGroup) syncChat(activeSurface(nextGroup))
        return
      }
      const current = editorLayoutOf(sessionId)
      const group = current && focusedGroup(current)
      if (group) closeTabIn(group.id, activeSurface(group))
    }
    window.addEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
  }, [closeTabIn, paneFocused, sessionId, syncChat, update])

  const surfaceInGroup = (groupId: string): SessionSurface | undefined => {
    const group = groupsOf((editorLayoutOf(sessionId) ?? layout).root).find((g) => g.id === groupId)
    return group && activeSurface(group)
  }

  const viewRail = <ViewRail tabs={railTabs} active={activeTab} onChange={selectTab} menus={viewRailMenus} />

  return (
    <>
      {viewRailTarget !== null && paneFocused ? createPortal(viewRail, viewRailTarget) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <EditorGroups
          sessionId={sessionId}
          layout={layout}
          // Layout-only updates keep this token, while render dependencies replace it.
          revision={renderRevision}
          describe={describeSurface}
          renderBody={renderBody}
          onActivate={(groupId, surface) => {
            update((current) => activateTab(current, groupId, sessionSurfaceKey(surface)))
            if (surface.kind === "chat") props.onFocusChat?.(sessionId, surface.id)
            else syncChat(surface)
          }}
          onClose={closeTabIn}
          onDrop={(drag, groupId, edge, copy) => {
            update((current) => dropTab(current, drag, groupId, edge, copy, mainChatId))
            syncChat(drag.surface)
          }}
          onFocusGroup={(groupId) => {
            update((current) => focusEditorGroup(current, groupId))
            const surface = surfaceInGroup(groupId)
            if (surface) syncChat(surface)
          }}
          onResize={(splitId, index, delta) => update((current) => resizeSplit(current, splitId, index, delta))}
          launcherItems={launcherItems}
        />
        {props.renderReviewTray?.(active, { onConnectGithub: connectGithub })}
        {viewRailTarget === null ? viewRail : null}
      </div>
    </>
  )
}
