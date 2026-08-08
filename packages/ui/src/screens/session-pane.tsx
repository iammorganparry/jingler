import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { DiffStat, Session, SessionActivity, SessionDisplayStatus } from "@jingler/core"
import { activityLabel, displayStatusOf, UNTITLED_SESSION } from "@jingler/core"
import { displayStatusLabel } from "../tokens.js"
import { usePaneWidth, WidthTierProvider } from "../hooks/width-tier.js"
import { ResizeHandle } from "../components/resizable.js"
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
import {
  clampedSessionAuxiliaryRatio,
  DEFAULT_SESSION_AUXILIARY_RATIO,
  resizedSessionAuxiliaryRatio,
  SESSION_AUXILIARY_SPLIT_BREAKPOINT,
  SESSION_AUXILIARY_SPLIT_HANDLE_WIDTH
} from "../app/session-auxiliary-split.js"

const SESSION_AUXILIARY_RATIO_KEY = "sb.split.session-auxiliary.ratio"
const LEGACY_SESSION_BROWSER_RATIO_KEY = "sb.split.session-browser.ratio"

const initialSessionAuxiliaryRatio = (): number => {
  try {
    const stored = Number(
      localStorage.getItem(SESSION_AUXILIARY_RATIO_KEY) ??
        localStorage.getItem(LEGACY_SESSION_BROWSER_RATIO_KEY)
    )
    return Number.isFinite(stored) && stored > 0 && stored < 1
      ? stored
      : DEFAULT_SESSION_AUXILIARY_RATIO
  } catch {
    return DEFAULT_SESSION_AUXILIARY_RATIO
  }
}

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

export interface SessionPaneProps {
  /** The session this pane shows. A pane only exists for a filled grid slot. */
  session: Session
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
  /** Render the session-native repository browser and editor. */
  renderFiles?: (
    session: Session,
    ctx: { readonly onSelectConversation: () => void }
  ) => ReactNode
  /** Render this session's embedded browser inside its pane. */
  renderBrowser?: (session: Session) => ReactNode
  /** Select a path in the session's persistent file-browser actor. */
  onOpenFile?: (sessionId: string, path: string) => void
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
    ctx: {
      readonly activeTabId: TabKey
      readonly onSelectConversation: () => void
      readonly onSelectFiles: () => void
    }
  ) => ReactNode
  /** Rename the session from the tab-row title. */
  onRenameSession?: (id: string, title: string) => void
  /** Toggle the embedded browser that belongs to this session. */
  onToggleBrowser?: (sessionId: string) => void
  /** Read this session's browser visibility without borrowing focused state. */
  isBrowserActive?: (sessionId: string) => boolean
  /** Session ids that should surface a Plan Review tab (plan mode / has a plan). */
  planSessions?: ReadonlySet<string>
  /** What each session's agent is doing right now, keyed by id (live). */
  liveActivity?: Record<string, SessionActivity>
  /** Live per-session worktree diff totals, for the Changes tab badge. */
  liveDiff?: Record<string, DiffStat>
  /** Open the Settings view — the "connect GitHub" escape hatch on empty states. */
  onOpenSettings?: () => void
  /** Render the Pull Request tab; `ctx.onConnectGithub` opens the settings modal. */
  renderPullRequest?: (session: Session, ctx: { onConnectGithub: () => void }) => ReactNode
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

function SessionPaneBody(props: SessionPaneProps) {
  const [tab, setTab] = useState<TabKey>("conversation")
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
  const [split, setSplit] = useState(false)
  const paneWidth = usePaneWidth().width
  const hasPlan = props.planSessions?.has(props.session.id) ?? false
  const supportsAuxiliarySplit =
    paneWidth === 0 || paneWidth >= SESSION_AUXILIARY_SPLIT_BREAKPOINT
  const [auxiliaryRatio, setAuxiliaryRatio] = useState(initialSessionAuxiliaryRatio)
  const effectiveAuxiliaryRatio = clampedSessionAuxiliaryRatio(auxiliaryRatio, paneWidth)
  const adjustAuxiliarySplit = useCallback(
    (deltaX: number) => {
      if (paneWidth <= 0) return
      const next = resizedSessionAuxiliaryRatio(effectiveAuxiliaryRatio, paneWidth, deltaX)
      setAuxiliaryRatio(next)
      try {
        localStorage.setItem(SESSION_AUXILIARY_RATIO_KEY, String(next))
      } catch {
        /* A private/quota-limited renderer still keeps the in-memory ratio. */
      }
    },
    [effectiveAuxiliaryRatio, paneWidth]
  )
  const openPlanReview = useCallback(
    (stepId?: string) => {
      setTarget(stepId ? { sessionId: props.session.id, stepId } : null)
      // Plan follows the same responsive boundary as every other auxiliary
      // view: two thirds beside chat when there is room, full-width otherwise.
      if (supportsAuxiliarySplit && hasPlan) {
        setTab(BUILTIN_TAB.conversation)
        setSplit(true)
      } else {
        setTab(BUILTIN_TAB.plan)
      }
    },
    [props.session.id, supportsAuxiliarySplit, hasPlan]
  )
  const presentPlanDraft = useCallback(() => openPlanReview(), [openPlanReview])

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
    if (tabRequestId === BUILTIN_TAB.plan) openPlanReview()
    else setTab(tabRequestId)
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
  const browserActive = props.isBrowserActive?.(active.id) ?? false
  const previousBrowserActive = useRef(false)
  useEffect(() => {
    if (browserActive && !previousBrowserActive.current && tab !== BUILTIN_TAB.browser) {
      setTab(BUILTIN_TAB.browser)
    }
    if (!browserActive && previousBrowserActive.current && tab === BUILTIN_TAB.browser) {
      setTab(BUILTIN_TAB.conversation)
    }
    previousBrowserActive.current = browserActive
  }, [browserActive, tab])

  const selectTab = useCallback(
    (nextTab: TabKey) => {
      if (nextTab === BUILTIN_TAB.browser && !browserActive) {
        props.onToggleBrowser?.(active.id)
      } else if (nextTab !== BUILTIN_TAB.browser && browserActive) {
        props.onToggleBrowser?.(active.id)
      }
      if (nextTab === BUILTIN_TAB.plan) openPlanReview()
      else setTab(nextTab)
    },
    [active.id, browserActive, openPlanReview, props.onToggleBrowser]
  )
  const planStepTarget = target?.sessionId === active.id ? target.stepId : null

  // What every contribution's `when` and `badge` gets to reason about. Assembled
  // once rather than per tab: `hasPlan` and `diff` are lookups the old if/push
  // chain did inline, and doing them per contribution would repeat them per tab
  // per render.
  const tabCtx: TabContext = {
    session: active,
    hasPlan,
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
   * the MOUNTED SUBTREE, and that is keyed by mount group below — not by the
   * identity of this array.
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
          onPlanDraftAvailable: presentPlanDraft,
          planStepId: planStepTarget,
          onPlanStepSelected: () => setTarget(null),
          // "Is this the pane the operator is looking at?" — a group of one has
          // no `pane` prop at all, and is always the one being looked at.
          paneFocused: props.pane === undefined || props.pane.focused
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
      pullRequest: (session, ctx) =>
        props.renderPullRequest?.(session, {
          onConnectGithub: ctx.onConnectGithub
        }),
      review: (session, ctx) =>
        props.renderReview?.(session, { onConnectGithub: ctx.onConnectGithub }),
      code: (session, ctx) => props.renderCode?.(session, { onConnectGithub: ctx.onConnectGithub }),
      files: (session, ctx) =>
        props.renderFiles?.(session, {
          onSelectConversation: () => ctx.onSelectTab(BUILTIN_TAB.conversation)
        }),
      browser: (session) => props.renderBrowser?.(session),
      stub: (id) => <BuiltinStubScreen tab={id} />
    }),
    ...(props.tabContributions ?? [])
  ]

  const tabs = visibleTabs(tabCtx, contributions)
  // Never leave a hidden tab selected (e.g. after a session's PR is merged away,
  // or after the plugin that owned the selected tab was disabled). Falling back
  // to the first visible tab rather than the literal "conversation" keeps this
  // honest if the built-in set ever changes.
  const activeContribution = tabs.find((c) => c.id === tab) ?? tabs[0]
  const activeTab = activeContribution?.id ?? BUILTIN_TAB.conversation
  const conversationContribution = tabs.find((c) => c.id === BUILTIN_TAB.conversation)
  // Every auxiliary view follows the Browser layout: at 960px, the default
  // thirds yield a 320px chat and a 640px work surface. Any narrower and both
  // stop being useful, so the selected view takes the full pane. Plan is the one
  // exception in shape only: its shared conversation subtree already owns an
  // equivalent two-thirds split and its responsive fallback.
  const auxiliarySplitOpen =
    activeTab !== BUILTIN_TAB.conversation &&
    activeTab !== BUILTIN_TAB.plan &&
    supportsAuxiliarySplit
  useEffect(() => {
    props.onActiveTabChange?.(active.id, activeTab)
  }, [active.id, activeTab, props.onActiveTabChange])
  // Plan Review beside the transcript. Derived, never merely stored: a session
  // with no plan has nothing to split, so the same reasoning that hides the Plan
  // tab collapses the split — otherwise a plan-less session would leave an empty
  // column pinned open with no control on screen to close it.
  //
  // The plan column has a 360px floor. Below the shared 960px auxiliary-view
  // boundary, Plan Review becomes the full-width tab instead of squeezing chat
  // into a sliver.
  const splitAvailable =
    activeTab === BUILTIN_TAB.conversation &&
    // The plan tab is now always present; only offer the split once there is an
    // actual plan to show beside the conversation.
    tabCtx.hasPlan &&
    supportsAuxiliarySplit
  const splitOpen = split && splitAvailable
  // What this session's agent is doing — drives the tab bar's pill.
  const activeActivity = props.liveActivity?.[active.id] ?? null

  /** What the tab actually on screen is handed. */
  const renderCtx: TabRenderContext = {
    activeTabId: activeTab,
    splitOpen,
    onConnectGithub: connectGithub,
    onSelectTab: selectTab
  }

  return (
    <>
      <TabBar
        tabs={tabs
          // The desktop always supplies chat pills, and each pill is now the
          // route back to the transcript. Standalone stories may omit them, so
          // keep Conversation there rather than creating a one-way tab bar.
          .filter(
            (contribution) =>
              props.renderChatTabs === undefined || contribution.id !== BUILTIN_TAB.conversation
          )
          .map((contribution) => describeTab(contribution, tabCtx))}
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
          onSelectFiles: () => selectTab(BUILTIN_TAB.files)
        })}
        // The title comes from the session rather than from the caller, so the
        // chip follows a rename the moment it lands.
        pane={props.pane ? { ...props.pane, title: active.title || UNTITLED_SESSION } : undefined}
        onToggleSplit={splitAvailable ? () => setSplit((v) => !v) : undefined}
        splitActive={splitOpen}
        onClosePane={props.onClosePane}
        onMovePaneLeft={props.onMovePaneLeft}
        onMovePaneRight={props.onMovePaneRight}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/*
          One dispatch, where there used to be a five-branch ternary chain.

          The mount key is what preserves the behaviour that chain encoded:
          tabs in the same MOUNT GROUP share one subtree and swap faces
          internally, everything else remounts on switch. Conversation and Plan
          Review declare the same group, so switching to Plan never unmounts —
          and thus never aborts — a parked plan run; every other tab keeps the
          old remount-on-switch semantics, which the virtualized transcript
          REQUIRES of its neighbours (its measurement cache corrupts if it is
          kept mounted-but-hidden).

          The session id is in the key too, so a pane reused for a different
          session never hands the new session's data to the old subtree.
        */}
        <div
          key={`${
            auxiliarySplitOpen
              ? `auxiliary-split:${activeContribution?.mountGroup ?? activeTab}`
              : (activeContribution?.mountGroup ?? activeTab)
          }:${active.id}`}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {auxiliarySplitOpen ? (
            <div
              data-testid={
                activeTab === BUILTIN_TAB.browser
                  ? "session-browser-split"
                  : "session-auxiliary-split"
              }
              className="flex min-h-0 min-w-0 flex-1"
            >
              <div
                data-testid={
                  activeTab === BUILTIN_TAB.browser
                    ? "session-browser-chat"
                    : "session-auxiliary-chat"
                }
                className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              >
                {conversationContribution?.render(active, {
                  ...renderCtx,
                  activeTabId: BUILTIN_TAB.conversation
                })}
              </div>
              <ResizeHandle
                aria-label={`Resize ${activeContribution?.label ?? "session view"}`}
                onResize={adjustAuxiliarySplit}
              />
              <div
                data-testid={
                  activeTab === BUILTIN_TAB.browser
                    ? "session-browser-panel"
                    : "session-auxiliary-panel"
                }
                style={{
                  width: `calc(${effectiveAuxiliaryRatio * 100}% - ${effectiveAuxiliaryRatio * SESSION_AUXILIARY_SPLIT_HANDLE_WIDTH}px)`
                }}
                className="flex min-h-0 min-w-0 flex-none overflow-hidden"
              >
                {activeContribution?.render(active, renderCtx)}
              </div>
            </div>
          ) : (
            activeContribution?.render(active, renderCtx)
          )}
        </div>
      </div>
    </>
  )
}
