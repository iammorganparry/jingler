import {
  type ReactNode,
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
  SessionDisplayStatus
} from "@jingler/core"
import {
  activityLabel,
  displayStatusOf,
  issueReferenceOf,
  issueReferencesOf,
  UNTITLED_SESSION
} from "@jingler/core"
import { displayStatusLabel } from "../tokens.js"
import { usePaneWidth, WidthTierProvider } from "../hooks/width-tier.js"
import { TabBar } from "../app/tab-bar.js"
import {
  BUILTIN_TAB,
  builtinTabContributions,
  describeTab,
  type TabContext,
  type TabContribution,
  type TabKey,
  type TabRenderContext,
  visibleTabs
} from "../app/tab-contributions.js"
import { ConversationView } from "../app/conversation-view.js"
import { SEED_CONVERSATION } from "../seed.js"
import { BuiltinStubScreen } from "./stub-screen.js"
import { ViewRail, type ViewRailMenu } from "../app/view-rail.js"
import { SplitView } from "../app/split-view.js"
import {
  SESSION_SURFACE_COMMAND_EVENT,
  SESSION_SURFACE_DND_MIME,
  closeAllSessionViews,
  closeSessionPane,
  closeSessionSurface,
  createSessionSurfaceLayout,
  focusSessionSurface,
  loadSessionSurfaceLayout,
  maxSessionSurfacesForWidth,
  moveSessionPane,
  openSessionSurface,
  openSessionView,
  parseSessionSurfaceKey,
  pruneSessionSurfaceLayout,
  replaceSessionSurface,
  resizeSessionSurface,
  saveSessionSurfaceLayout,
  selectSessionSurface,
  sessionSurfaceKey,
  splitSessionSurface,
  type SessionSurface,
  type SessionSurfaceCommand,
  type SessionSurfaceLayout,
  type SessionSurfacePane
} from "../app/session-surface-layout.js"
import type { TabLauncherItem } from "../app/chat-tab-bar.js"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { cn } from "../lib/cn.js"

const issueMenuValue = (issue: IssueReference): string =>
  `${issue.providerId}:${issue.providerAccountId ?? ""}:${issue.id}`

/**
 * The tab-bar pill's accent per reported state. Blue means "you're needed" and is
 * reserved for exactly that — anything the agent is doing under its own steam is
 * yellow, however long it takes. (Monitoring a PR is still the agent's work, not
 * yours; tinting it blue would dilute the one signal that should pull an eye.)
 */
const DISPLAY_TONE: Record<SessionDisplayStatus, "yellow" | "blue" | "green"> = {
  thinking: "yellow",
  running: "yellow",
  monitoring: "yellow",
  "needs-input": "blue",
  idle: "yellow"
}

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
  /** Open a repository path in this session's Files tab. */
  onOpenFile: (path: string) => void
  /** Present the Files workspace without requiring a path to be selected. */
  onSelectFiles: () => void
  /** Present canonical worktree changes for mutation recovery inspection. */
  onSelectChanges: () => void
  /** Open provider settings for authentication or certification recovery. */
  onOpenProviderSettings: () => void
  /** Present the first renderable streamed draft using this pane's width. */
  onPlanDraftAvailable?: () => void
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
      readonly path?: string
      readonly onClosed?: () => void
    }
  ) => ReactNode
  /** Render this session's embedded browser inside its pane. */
  renderBrowser?: (session: Session) => ReactNode
  /** Render the session terminal as a normal closable/splittable view. */
  renderTerminal?: (session: Session) => ReactNode
  /** Select a path in the session's persistent file-browser actor. */
  onOpenFile?: (sessionId: string, path: string) => void
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
  /** Render the Code Review tab; `ctx.onConnectGithub` opens the settings modal. */
  renderReview?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
  /** Render the Changes tab — the Code Review view over the local worktree diff. */
  renderCode?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
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
 * collapses against THIS pane's width, so a four-way split degrades each pane
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

function surfaceChatId(surface: SessionSurface, fallbackChatId: string): string {
  if (surface.kind === "chat") return surface.id
  if (surface.kind === "view" && surface.chatId) return surface.chatId
  return fallbackChatId
}

function resolveVisibleTab(tabs: ReadonlyArray<TabContribution>, tab: TabKey): TabKey {
  if (tabs.some((contribution) => contribution.id === tab)) return tab
  return tabs[0]?.id ?? BUILTIN_TAB.conversation
}

function SessionPaneBody(props: SessionPaneProps) {
  function buildProviderMenus() {
  const providerMenus: Record<TabKey, ViewRailMenu | undefined> = {}
  if (!props.onSelectIssue) return providerMenus
    for (const contribution of tabs) {
      const providerId = contribution.issueProviderId
      if (!providerId) continue
      const issues = issueReferencesOf(active).filter(
        (issue) => issue.providerId === providerId
      )
      if (issues.length < 2) continue
      const selected =
        selectedIssue?.providerId === providerId ? selectedIssue : issues[0]!
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
          props.onSelectIssue?.(active.id, {
            providerId: issue.providerId,
            ...(issue.providerAccountId
              ? { providerAccountId: issue.providerAccountId }
              : {}),
            id: issue.id
          })
        }
      }
    }
    return providerMenus
  }

  function renderPaneLayout() {
    return (<>
      {titleBarTarget === null
        ? tabBar
        : (props.pane === undefined || props.pane.focused)
          ? createPortal(tabBar, titleBarTarget)
          : null}
      {viewRailTarget !== null && paneFocused
        ? createPortal(viewRail, viewRailTarget)
        : null}
      {props.renderSubagentTabs?.(active, {
        activeTabId: activeTab,
        onSelectConversation: () => selectTab(BUILTIN_TAB.conversation)
      })}

      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <SplitView<SessionSurfacePane>
          group={surfaceLayout}
          renderPane={renderSurfacePane}
          paneId={surfacePaneKey}
          dragMime={SESSION_SURFACE_DND_MIME}
          testIdPrefix="surface"
          paneCapacity={maxSessionSurfacesForWidth}
          onFocusPane={focusSurface}
          onSplitWith={(payload, at) => {
            const surface = parseSessionSurfaceKey(payload)
            if (!surface) return
            setSurfaceLayout((current) =>
              splitSessionSurface(
                current,
                surface,
                at,
                maxSessionSurfacesForWidth(paneWidth)
              )
            )
          }}
          onReplacePane={(index, payload) => {
            const surface = parseSessionSurfaceKey(payload)
            if (!surface) return
            setSurfaceLayout((current) => replaceSessionSurface(current, index, surface))
          }}
          onResize={(index, delta) =>
            setSurfaceLayout((current) => resizeSessionSurface(current, index, delta))
          }
        />
        {viewRailTarget === null ? viewRail : null}
      </div>
    </>)
  }

  function renderTabBar() {
    return (<TabBar
            inTitleBar={titleBarTarget !== null}
            tabs={[]}
            active={activeTab}
            onChange={selectTab}
            status={
              activeActivity
                ? {
                    // ONE vocabulary for a session's state, shared with the sidebar:
                    // "Thinking", "Running", "Needs Input", "Monitoring", "Idle". The
                    // pill used to read the raw activity ("Running npm test…"), so
                    // the same session answered "what are you doing?" two different
                    // ways depending on which part of the window you looked at — and
                    // the target string grew the pill on every tool call.
                    label: displayStatusLabel[displayStatusOf(activeActivity, active.status)],
                    tone: DISPLAY_TONE[displayStatusOf(activeActivity, active.status)],
                    // The specifics survive on hover, exactly as they do in the row.
                    detail: activityLabel(activeActivity)
                  }
                : undefined
            }
            // The title comes from the session rather than from the caller, so the
            // pane identity follows a rename the moment it lands.
            sessionTitle={active.title || UNTITLED_SESSION}
            repoName={active.repo}
            onRenameTitle={
              props.onRenameSession ? (title) => props.onRenameSession?.(active.id, title) : undefined
            }
            // The chat pills share the tab row, behind a divider. Built by the
            // renderer (RPCs + live activity), threaded in as an opaque node.
            chatSlot={props.renderChatTabs?.(active, {
              activeTabId: activeTab,
              onSelectConversation: () => selectTab(BUILTIN_TAB.conversation),
              onSelectFiles: () => selectTab(BUILTIN_TAB.files),
              activeSurface: focusedSurface,
              onSelectSurface: (surface) => {
                setSurfaceLayout((current) =>
                  openSessionSurface(
                    current,
                    surface,
                    maxSessionSurfacesForWidth(paneWidth)
                  )
                )
              },
              onCloseSurface: (surface) => {
                if (
                  surface.kind === "chat" &&
                  props.isBrowserActive?.(active.id, surface.id)
                ) {
                  props.onToggleBrowser?.(active.id, surface.id)
                }
                setSurfaceLayout((current) => {
                  const withoutOwnedViews =
                    surface.kind === "chat"
                      ? current.openViews
                          .filter((view) => view.chatId === surface.id)
                          .reduce(
                            (layout, view) =>
                              closeSessionSurface(layout, view, fallbackChatSurface),
                            current
                          )
                      : current
                  return closeSessionSurface(
                    withoutOwnedViews,
                    surface,
                    fallbackChatSurface
                  )
                })
              },
              onRequestCloseFile: props.onRequestCloseFile
                ? (path) => props.onRequestCloseFile?.(active.id, path) ?? true
                : undefined,
              viewSlot,
              viewCount: surfaceLayout.openViews.length,
              viewsActive:
                focusedSurface.kind === "view" && focusedSurface.id !== BUILTIN_TAB.files,
              onCloseAllViews: closeAllViews,
              viewLauncherItems,
              paneFocused: props.pane === undefined || props.pane.focused
            })}
            // The title comes from the session rather than from the caller, so the
            // chip follows a rename the moment it lands.
            pane={props.pane ? { ...props.pane, title: active.title || UNTITLED_SESSION } : undefined}
          />)
  }

  const paneWidth = usePaneWidth().width
  const [titleBarTarget, setTitleBarTarget] = useState<HTMLElement | null>(null)
  const [viewRailTarget, setViewRailTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (typeof document === "undefined") return
    setTitleBarTarget(document.getElementById("session-tab-bar-portal"))
    setViewRailTarget(document.getElementById("session-view-rail-portal"))
  }, [])
  const fallbackSurface: SessionSurface = { kind: "chat", id: props.session.activeChatId }
  const [surfaceLayout, setSurfaceLayout] = useState<SessionSurfaceLayout>(() => {
    const restored = loadSessionSurfaceLayout(props.session.id, fallbackSurface)
    if (props.initialTab && props.initialTab !== BUILTIN_TAB.conversation) {
      return openSessionView(restored, { kind: "view", id: props.initialTab })
    }
    return restored
  })
  const filePanePaths = useMemo(
    () => surfaceLayout.panes.flatMap(({ surface }) =>
      surface.kind === "file" ? [surface.id] : []
    ),
    [surfaceLayout.panes]
  )
  useEffect(() => {
    for (const path of filePanePaths) props.onOpenFile?.(props.session.id, path)
  }, [filePanePaths, props.onOpenFile, props.session.id])
  const focusedSurface = surfaceLayout.panes[surfaceLayout.focused]?.surface ?? fallbackSurface
  const [tab, setTab] = useState<TabKey>(() =>
    focusedSurface.kind === "view"
      ? focusedSurface.id
      : focusedSurface.kind === "file"
        ? BUILTIN_TAB.files
        : BUILTIN_TAB.conversation
  )
  const lastDebugStop = useRef(0)
  useEffect(() => {
    const sequence = props.debugStopSequence ?? 0
    if (sequence > 0 && sequence !== lastDebugStop.current) {
      setTab(BUILTIN_TAB.files)
      setSurfaceLayout((current) =>
        openSessionSurface(
          current,
          { kind: "view", id: BUILTIN_TAB.files },
          maxSessionSurfacesForWidth(paneWidth)
        )
      )
    }
    lastDebugStop.current = sequence
  }, [paneWidth, props.debugStopSequence])
  // A pending deep link into Plan Review (set when the composer dock jumps to
  // a step). One-shot: Plan Review reports its own selection back and we drop it,
  // so a later manual pick isn't overridden by a stale target.
  //
  // Still tagged with its session even though a pane is now keyed by session id:
  // the tag costs nothing and keeps the invariant local rather than depending on
  // every caller remembering to key correctly. Step ids are per-plan ordinals
  // (s_01, s_02…) that collide across sessions, so an untagged target that
  // survived a re-key would snap to an unrelated same-numbered step.
  const [target, setTarget] = useState<{
    sessionId: string
    stepId: string
  } | null>(null)
  const hasPlan =
    props.session.chats.some((chat) => props.planSessions?.has(chat.id) ?? false)
  const previousOwner = useRef({
    sessionId: props.session.id,
    chatId: props.session.activeChatId
  })
  useEffect(() => {
    const previous = previousOwner.current
    if (
      previous.sessionId === props.session.id &&
      previous.chatId !== props.session.activeChatId
    ) {
      const focusedOwner =
        focusedSurface.kind === "chat"
          ? focusedSurface.id
          : focusedSurface.kind === "view"
            ? focusedSurface.chatId
            : undefined
      if (focusedOwner !== props.session.activeChatId) {
        setTab(BUILTIN_TAB.conversation)
        setSurfaceLayout((current) =>
          selectSessionSurface(current, {
            kind: "chat",
            id: props.session.activeChatId
          })
        )
        setTarget(null)
      }
    }
    previousOwner.current = {
      sessionId: props.session.id,
      chatId: props.session.activeChatId
    }
  }, [props.session.activeChatId, props.session.id])
  const hasExplanation = props.explanationSessions?.has(props.session.id) ?? false
  const openPlanReview = useCallback(
    (stepId?: string) => {
      setTarget(stepId ? { sessionId: props.session.id, stepId } : null)
      const surface: Extract<SessionSurface, { kind: "view" }> = {
        kind: "view",
        id: BUILTIN_TAB.plan,
        chatId: props.session.activeChatId
      }
      setSurfaceLayout((current) =>
        openSessionView(current, surface, maxSessionSurfacesForWidth(paneWidth))
      )
      setTab(BUILTIN_TAB.plan)
    },
    [paneWidth, props.session.activeChatId, props.session.id]
  )
  const presentPlanDraft = useCallback(() => {
    setTarget(null)
    setSurfaceLayout((current) =>
      openSessionView(
        current,
        {
          kind: "view",
          id: BUILTIN_TAB.plan,
          chatId: props.session.activeChatId
        },
        maxSessionSurfacesForWidth(paneWidth)
      )
    )
    setTab(BUILTIN_TAB.plan)
  }, [paneWidth, props.session.activeChatId, props.session.id])

  // An outside request to switch tabs (the command palette). The nonce is the
  // trigger, not the id — see `selectTabRequest`'s docblock. No validation here:
  // a tab that isn't visible is already handled downstream, where
  // `activeContribution` falls back to the first visible tab rather than
  // rendering nothing.
  //
  // Reporting it handled is NOT optional bookkeeping — a pane remounts on every
  // session switch, so an unconsumed request is replayed on the next session's
  // first render. Same shape as `onPlanStepSelected` a few lines down.
  const tabRequestNonce = props.selectTabRequest?.nonce
  const tabRequestId = props.selectTabRequest?.tabId
  const onTabRequestHandled = props.onTabRequestHandled
  useEffect(() => {
    if (tabRequestId === undefined) return
    if (tabRequestId === BUILTIN_TAB.plan) {
      openPlanReview()
    } else if (tabRequestId === BUILTIN_TAB.conversation) {
      setSurfaceLayout((current) =>
        openSessionSurface(
          current,
          { kind: "chat", id: props.session.activeChatId },
          maxSessionSurfacesForWidth(paneWidth)
        )
      )
      setTab(tabRequestId)
    } else if (tabRequestId === BUILTIN_TAB.files) {
      setSurfaceLayout((current) =>
        openSessionSurface(
          current,
          { kind: "view", id: BUILTIN_TAB.files },
          maxSessionSurfacesForWidth(paneWidth)
        )
      )
      setTab(tabRequestId)
    } else {
      if (
        tabRequestId === BUILTIN_TAB.browser &&
        !props.isBrowserActive?.(props.session.id, props.session.activeChatId)
      ) {
        props.onToggleBrowser?.(props.session.id, props.session.activeChatId)
      }
      setSurfaceLayout((current) =>
        openSessionView(
          current,
          {
            kind: "view",
            id: tabRequestId,
            ...(tabRequestId === BUILTIN_TAB.browser
              ? { chatId: props.session.activeChatId }
              : {})
          },
          maxSessionSurfacesForWidth(paneWidth)
        )
      )
      setTab(tabRequestId)
    }
    onTabRequestHandled?.()
    // Depends on the NONCE alone, deliberately: adding `tabRequestId` would
    // re-fire on a request for a different tab that carried the same nonce, and
    // adding the callback would re-fire whenever the owner re-rendered.
    //
    // No suppression comment here. The repo lints with Biome, whose rule is
    // `lint/correctness/useExhaustiveDependencies` and is configured `warn`, so
    // the `// eslint-disable-next-line` form used elsewhere in this codebase
    // suppresses nothing at all — it only claims to.
  }, [tabRequestNonce])

  const active = props.session
  const browserActive = props.isBrowserActive?.(active.id, active.activeChatId) ?? false
  const previousBrowser = useRef({ chatId: active.activeChatId, active: browserActive })
  useEffect(() => {
    const previous = previousBrowser.current
    if (previous.chatId !== active.activeChatId) {
      previousBrowser.current = { chatId: active.activeChatId, active: browserActive }
      return
    }
    const surface: Extract<SessionSurface, { kind: "view" }> = {
      kind: "view",
      id: BUILTIN_TAB.browser,
      chatId: active.activeChatId
    }
    if (browserActive && !previous.active) {
      setSurfaceLayout((current) =>
        openSessionView(current, surface, maxSessionSurfacesForWidth(paneWidth))
      )
      setTab(BUILTIN_TAB.browser)
    }
    if (!browserActive && previous.active) {
      setSurfaceLayout((current) =>
        closeSessionSurface(current, surface, { kind: "chat", id: active.activeChatId })
      )
    }
    previousBrowser.current = { chatId: active.activeChatId, active: browserActive }
  }, [active.activeChatId, browserActive, paneWidth])

  function selectTabIssue(nextTab: TabKey) {
      const providerId = props.tabContributions?.find(
        (contribution) => contribution.id === nextTab
      )?.issueProviderId
      const selectedIssue = issueReferenceOf(active)
      if (providerId && selectedIssue?.providerId !== providerId) {
        const issue = issueReferencesOf(active).find(
          (candidate) => candidate.providerId === providerId
        )
        if (issue) {
          props.onSelectIssue?.(active.id, {
            providerId: issue.providerId,
            ...(issue.providerAccountId
              ? { providerAccountId: issue.providerAccountId }
              : {}),
            id: issue.id
          })
        }
      }
  }

  const selectTab = useCallback(
    (nextTab: TabKey) => {
      selectTabIssue(nextTab)
      if (nextTab === BUILTIN_TAB.plan) {
        openPlanReview()
        return
      }
      if (nextTab === BUILTIN_TAB.conversation) {
        setSurfaceLayout((current) =>
          openSessionSurface(
            current,
            { kind: "chat", id: active.activeChatId },
            maxSessionSurfacesForWidth(paneWidth)
          )
        )
      } else if (nextTab === BUILTIN_TAB.files) {
        setSurfaceLayout((current) =>
          openSessionSurface(
            current,
            { kind: "view", id: BUILTIN_TAB.files },
            maxSessionSurfacesForWidth(paneWidth)
          )
        )
      } else {
        const surface: Extract<SessionSurface, { kind: "view" }> = {
          kind: "view",
          id: nextTab,
          ...(nextTab === BUILTIN_TAB.browser ? { chatId: active.activeChatId } : {})
        }
        if (nextTab === BUILTIN_TAB.browser && !browserActive) {
          props.onToggleBrowser?.(active.id, active.activeChatId)
        }
        setSurfaceLayout((current) =>
          openSessionView(current, surface, maxSessionSurfacesForWidth(paneWidth))
        )
      }
      setTab(nextTab)
    },
    [
      active,
      browserActive,
      openPlanReview,
      paneWidth,
      props.onSelectIssue,
      props.onToggleBrowser,
      props.tabContributions
    ]
  )
  const planStepTarget = target?.sessionId === active.id ? target.stepId : null

  // What every contribution's `when` and `badge` gets to reason about. Assembled
  // once rather than per tab: `hasPlan` and `diff` are lookups the old if/push
  // chain did inline, and doing them per contribution would repeat them per tab
  // per render.
  const tabCtx: TabContext = {
    session: active,
    hasPlan,
    hasExplanation,
    diff: props.liveDiff?.[active.id] ?? null
  }
  const connectGithub = props.onOpenSettings ?? (() => {})

  /**
   * The built-in tabs, then whatever plugins added.
   *
   * Rebuilt every render rather than memoised: the list is six closures over
   * props that change on every render anyway, so a memo would need every one of
   * them in its dependency array and would buy nothing but a stale-closure bug
   * the first time someone forgot one. What must stay stable across renders is
   * the MOUNTED SUBTREE, and that is keyed by surface identity below — not by
   * the identity of this array.
   */
  const contributions: ReadonlyArray<TabContribution> = [
    ...builtinTabContributions({
      conversation: (session, ctx) => {
        const paneCtx: ConversationPaneCtx = {
          onOpenPlanReview: (stepId) => {
            if (ctx.splitOpen) {
              setTarget(stepId ? { sessionId: session.id, stepId } : null)
            } else {
              openPlanReview(stepId)
            }
          },
          onOpenFile: (path) => {
            props.onOpenFile?.(session.id, path)
            ctx.onSelectTab(BUILTIN_TAB.files)
          },
          onSelectFiles: () => ctx.onSelectTab(BUILTIN_TAB.files),
          onSelectChanges: () => ctx.onSelectTab(BUILTIN_TAB.changes),
          onOpenProviderSettings: props.onOpenProviderSettings ?? connectGithub,
          onPlanDraftAvailable: presentPlanDraft,
          planStepId: planStepTarget,
          onPlanStepSelected: () => setTarget(null),
          // Inner surface focus refines the outer session-pane focus.
          paneFocused:
            ctx.paneFocused ?? (props.pane === undefined || props.pane.focused)
        }
        if (!props.renderConversation) {
          return (
            props.conversationPane ?? (
              <ConversationView messages={SEED_CONVERSATION} mode="accept-edits" />
            )
          )
        }
        return props.renderConversation(
          session,
          ctx.activeTabId === BUILTIN_TAB.plan ? "plan" : ctx.splitOpen ? "split" : "conversation",
          paneCtx
        )
      },
      explanation: (session) => props.renderExplanation?.(session),
      pullRequest: (session, ctx) =>
        props.renderPullRequest?.(session, {
          onConnectGithub: ctx.onConnectGithub,
          onSelectReview: () => ctx.onSelectTab(BUILTIN_TAB.review)
        }),
      review: (session, ctx) =>
        props.renderReview?.(session, { onConnectGithub: ctx.onConnectGithub }),
      code: (session, ctx) => props.renderCode?.(session, { onConnectGithub: ctx.onConnectGithub }),
      files: (session, ctx) =>
        props.renderFiles?.(session, {
          onSelectConversation: () => ctx.onSelectTab(BUILTIN_TAB.conversation)
        }),
      browser: (session) => props.renderBrowser?.(session),
      terminal: (session) => props.renderTerminal?.(session),
      stub: (id) => <BuiltinStubScreen tab={id} />
    }),
    ...(props.tabContributions ?? [])
  ]

  const tabs = visibleTabs(tabCtx, contributions)
  const allowedViewKeys = tabs.flatMap((contribution) => {
    if (contribution.id === BUILTIN_TAB.conversation || contribution.id === BUILTIN_TAB.files) {
      return []
    }
    if (contribution.id === BUILTIN_TAB.browser) {
      return active.chats.map((chat) =>
        sessionSurfaceKey({ kind: "view", id: contribution.id, chatId: chat.id })
      )
    }
    if (contribution.id === BUILTIN_TAB.plan) {
      return active.chats
        .filter((chat) => props.planSessions?.has(chat.id) ?? false)
        .map((chat) =>
          sessionSurfaceKey({ kind: "view", id: contribution.id, chatId: chat.id })
        )
    }
    return [sessionSurfaceKey({ kind: "view", id: contribution.id })]
  })
  const allowedSurfaceKeys = new Set<string>([
    ...active.chats.map((chat) => sessionSurfaceKey({ kind: "chat", id: chat.id })),
    ...(active.worktreePath
      ? [sessionSurfaceKey({ kind: "view", id: BUILTIN_TAB.files })]
      : []),
    ...surfaceLayout.panes
      .filter((pane) => pane.surface.kind === "file")
      .map((pane) => sessionSurfaceKey(pane.surface)),
    ...allowedViewKeys
  ])
  const allowedSurfaceSignature = [...allowedSurfaceKeys].sort().join("\n")
  useEffect(() => {
    setSurfaceLayout((current) => {
      const next = pruneSessionSurfaceLayout(current, allowedSurfaceKeys, {
        kind: "chat",
        id: active.activeChatId
      })
      return JSON.stringify(next) === JSON.stringify(current) ? current : next
    })
  }, [active.activeChatId, allowedSurfaceSignature])
  useEffect(() => {
    saveSessionSurfaceLayout(active.id, surfaceLayout)
  }, [active.id, surfaceLayout])
  useEffect(() => {
    const surface = surfaceLayout.panes[surfaceLayout.focused]?.surface
    if (!surface) return
    setTab(
      surface.kind === "view"
        ? surface.id
        : surface.kind === "file"
          ? BUILTIN_TAB.files
          : BUILTIN_TAB.conversation
    )
  }, [surfaceLayout.focused, surfaceLayout.panes])

  // Never leave a hidden tab selected (e.g. after a session's PR is merged away,
  // or after the plugin that owned the selected tab was disabled). Falling back
  // to the first visible tab rather than the literal "conversation" keeps this
  // honest if the built-in set ever changes.
  const activeTab = resolveVisibleTab(tabs, tab)
  const conversationContribution = tabs.find((c) => c.id === BUILTIN_TAB.conversation)
  useEffect(() => {
    props.onActiveTabChange?.(active.id, activeTab)
  }, [active.id, activeTab, props.onActiveTabChange])
  const activeActivity = props.liveActivity?.[active.id] ?? null

  // The view tabs render in the right-edge rail rather than the tab bar: on a
  // narrow pane they fought the chat titles for width, and a rail spends
  // height instead. Same descriptors, same order, one code path for plugins.
  const railTabs = tabs
    // The desktop always supplies chat pills, and each pill is now the
    // route back to the transcript. Standalone stories may omit them, so
    // keep Conversation there rather than creating a one-way rail.
    .filter(
      (contribution) =>
        props.renderChatTabs === undefined || contribution.id !== BUILTIN_TAB.conversation
    )
    .map((contribution) => describeTab(contribution, tabCtx))

  const selectedIssue = issueReferenceOf(active)
  const providerMenus = buildProviderMenus()
  const viewRailMenus = { ...providerMenus, ...props.viewRailMenus }
  const fallbackChatSurface: SessionSurface = { kind: "chat", id: active.activeChatId }
  const closeViewSurface = (surface: Extract<SessionSurface, { kind: "view" }>) => {
    if (
      surface.id === BUILTIN_TAB.browser &&
      props.isBrowserActive?.(active.id, surface.chatId ?? active.activeChatId)
    ) {
      props.onToggleBrowser?.(active.id, surface.chatId ?? active.activeChatId)
    }
    setSurfaceLayout((current) => closeSessionSurface(current, surface, fallbackChatSurface))
  }
  const closeAllViews = () => {
    for (const surface of surfaceLayout.openViews) {
      if (
        surface.id === BUILTIN_TAB.browser &&
        props.isBrowserActive?.(active.id, surface.chatId ?? active.activeChatId)
      ) {
        props.onToggleBrowser?.(active.id, surface.chatId ?? active.activeChatId)
      }
    }
    setSurfaceLayout((current) => closeAllSessionViews(current, fallbackChatSurface))
  }
  const viewSlot = surfaceLayout.openViews.flatMap((surface) => {
    const contribution = tabs.find((candidate) => candidate.id === surface.id)
    if (!contribution) return []
    const descriptor = describeTab(contribution, tabCtx)
    const Icon = descriptor.icon
    const duplicate = surfaceLayout.openViews.some(
      (candidate) => candidate !== surface && candidate.id === surface.id
    )
    const ownerChat = surface.chatId
      ? active.chats.find((chat) => chat.id === surface.chatId)
      : undefined
    const label =
      duplicate && ownerChat
        ? `${descriptor.label} · ${ownerChat.title ?? "Chat"}`
        : descriptor.label
    const activeView = sessionSurfaceKey(surface) === sessionSurfaceKey(focusedSurface)
    return [
      <div
        key={sessionSurfaceKey(surface)}
        data-testid={`open-view-tab-${surface.id}`}
        data-chat={surface.chatId}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(SESSION_SURFACE_DND_MIME, sessionSurfaceKey(surface))
          event.dataTransfer.effectAllowed = "move"
        }}
        className={cn(
          "group flex flex-none items-center rounded-md transition-colors",
          activeView
            ? "bg-panel text-text-bright"
            : "text-muted-foreground hover:bg-panel/60 hover:text-text"
        )}
      >
        <button
          type="button"
          aria-current={activeView ? "page" : undefined}
          aria-label={label}
          title={label}
          onClick={() => {
            setSurfaceLayout((current) =>
              openSessionSurface(
                current,
                surface,
                maxSessionSurfacesForWidth(paneWidth)
              )
            )
            setTab(surface.id)
          }}
          className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1 text-left text-xs outline-none"
        >
          <Icon className="size-3 flex-none text-dim" />
          <span className="max-w-[150px] truncate">{label}</span>
        </button>
        <button
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={() => closeViewSurface(surface)}
          className="mr-1 rounded p-0.5 text-dim opacity-0 outline-none hover:bg-editor hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    ]
  })
  const viewLauncherItems: ReadonlyArray<TabLauncherItem> = railTabs
    .toSorted((left, right) => {
      const priority = (id: TabKey) =>
        id === BUILTIN_TAB.browser ? 0 : id === BUILTIN_TAB.terminal ? 1 : 2
      return priority(left.id) - priority(right.id)
    })
    .filter(
      (descriptor) =>
        descriptor.id !== BUILTIN_TAB.files &&
        (descriptor.id !== BUILTIN_TAB.plan ||
          (props.planSessions?.has(active.activeChatId) ?? false))
    )
    .map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      icon: descriptor.icon,
      ...(descriptor.id === BUILTIN_TAB.terminal
        ? { detail: "Open a shell in this worktree" }
        : {}),
      onSelect: () => selectTab(descriptor.id)
    }))

  const surfacePaneKey = (pane: SessionSurfacePane): string =>
    sessionSurfaceKey(pane.surface)

  const renderSurfaceContent = (pane: SessionSurfacePane, index: number) => {
    const surface = pane.surface
    const chatId = surfaceChatId(surface, active.activeChatId)
    const paneSession =
      chatId === active.activeChatId ? active : { ...active, activeChatId: chatId }
    const paneFocused =
      (props.pane === undefined || props.pane.focused) && index === surfaceLayout.focused
    const paneCtx: TabRenderContext = {
      activeTabId:
        surface.kind === "view"
          ? surface.id
          : surface.kind === "file"
            ? BUILTIN_TAB.files
            : BUILTIN_TAB.conversation,
      splitOpen: false,
      paneFocused,
      onConnectGithub: connectGithub,
      onSelectTab: selectTab
    }
    if (surface.kind === "chat") {
      return conversationContribution?.render(paneSession, {
        ...paneCtx,
        activeTabId: BUILTIN_TAB.conversation
      })
    }
    if (surface.kind === "file") {
      return props.renderFiles?.(paneSession, {
        onSelectConversation: () => selectTab(BUILTIN_TAB.conversation),
        path: surface.id,
        onClosed: () =>
          setSurfaceLayout((current) =>
            closeSessionSurface(current, surface, fallbackChatSurface)
          )
      })
    }
    const contribution = contributions.find((candidate) => candidate.id === surface.id)
    return contribution?.render(paneSession, {
      ...paneCtx,
      // The conversation renderer reads focus from its own ctx assembled in the
      // contribution closure. Keep the outer pane focused before interaction so
      // only one composer takes the caret.
      onSelectTab: (id) => {
        if (paneFocused) selectTab(id)
      }
    })
  }

  const focusSurface = useCallback((index: number) => {
    const surface = surfaceLayout.panes[index]?.surface
    setSurfaceLayout((current) => focusSessionSurface(current, index))
    const chatId =
      surface?.kind === "chat"
        ? surface.id
        : surface?.kind === "view"
          ? surface.chatId
          : undefined
    if (chatId && chatId !== active.activeChatId) props.onFocusChat?.(active.id, chatId)
  }, [active.activeChatId, active.id, props.onFocusChat, surfaceLayout.panes])
  const closeFocusedSurface = useCallback(() => {
    setSurfaceLayout((current) =>
      closeSessionPane(current, current.focused, fallbackChatSurface)
    )
  }, [fallbackChatSurface.id])
  const moveFocusedSurface = useCallback((direction: -1 | 1) => {
    setSurfaceLayout((current) =>
      moveSessionPane(current, current.focused, current.focused + direction)
    )
  }, [])
  const renderSurfacePane = (pane: SessionSurfacePane, index: number) => (
    <>
      <div
        data-testid={`surface-pane-toolbar-${index}`}
        className="flex h-8 flex-none items-center justify-end border-b border-hairline px-1.5"
      >
        {index > 0 && (
          <button
            type="button"
            aria-label={`Move pane ${index + 1} left`}
            title="Move pane left (⌃⇧⌥←)"
            onClick={() =>
              setSurfaceLayout((current) => moveSessionPane(current, index, index - 1))
            }
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        {index < surfaceLayout.panes.length - 1 && (
          <button
            type="button"
            aria-label={`Move pane ${index + 1} right`}
            title="Move pane right (⌃⇧⌥→)"
            onClick={() =>
              setSurfaceLayout((current) => moveSessionPane(current, index, index + 1))
            }
            className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label={`Close pane ${index + 1}`}
          title="Close pane (the tab stays open)"
          onClick={() =>
            setSurfaceLayout((current) => closeSessionPane(current, index, fallbackChatSurface))
          }
          className="flex size-6 items-center justify-center rounded text-dim transition-colors hover:bg-hairline hover:text-text-bright"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderSurfaceContent(pane, index)}
      </div>
    </>
  )
  const paneFocused = props.pane === undefined || props.pane.focused
  useEffect(() => {
    if (!paneFocused) return
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<SessionSurfaceCommand>).detail
      switch (command) {
        case "close": closeFocusedSurface(); return
        case "move-left": moveFocusedSurface(-1); return
        case "move-right": moveFocusedSurface(1); return
        case "focus-left": focusSurface(surfaceLayout.focused - 1); return
        case "focus-right": focusSurface(surfaceLayout.focused + 1); return
        default:
          if (command.startsWith("focus-")) focusSurface(Number(command.slice(6)))
      }
    }
    window.addEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(SESSION_SURFACE_COMMAND_EVENT, onCommand)
  }, [closeFocusedSurface, focusSurface, moveFocusedSurface, paneFocused, surfaceLayout.focused])

  const tabBar = (
    renderTabBar()
  )
  const viewRail = (
    <ViewRail
      tabs={railTabs}
      active={activeTab}
      onChange={selectTab}
      menus={viewRailMenus}
    />
  )

  return (
    renderPaneLayout()
  )
}
