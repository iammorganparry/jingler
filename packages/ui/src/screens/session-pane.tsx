import { type ReactNode, useState } from "react"
import type { DiffStat, Session, SessionActivity, SessionDisplayStatus } from "@starbase/core"
import { activityLabel, displayStatusOf, UNTITLED_SESSION } from "@starbase/core"
import { displayStatusLabel } from "../tokens.js"
import { atLeast, useWidthTier, WidthTierProvider } from "../hooks/width-tier.js"
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
   * Switch to the Plan Review tab, optionally focused on a step (the Conversation
   * progress rail deep-links; the inline plan card calls it bare).
   */
  onOpenPlanReview: (stepId?: string) => void
  /** The step Plan Review should open at, until the user picks another. */
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
   * The real app's session-keyed pane, rendered for BOTH the Conversation and
   * Plan tabs from the same machine (so switching to Plan never aborts a parked
   * plan run). `view` selects the face; `ctx.onOpenPlanReview` switches the tab.
   */
  renderConversation?: (
    session: Session,
    view: "conversation" | "plan" | "split",
    ctx: ConversationPaneCtx
  ) => ReactNode
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
  renderChatTabs?: (session: Session) => ReactNode
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
   * Toggle the browser-preview pane. App-level, not pane-level: the dock itself is
   * mounted once outside the grid, so every pane's copy of this control drives the
   * same one.
   */
  onToggleBrowser?: () => void
  /** Whether the browser-preview pane is currently open. */
  browserActive?: boolean
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
 * Not its docks — the terminal and browser preview are mounted once by
 * `SessionSplit`, outside every pane. See the comment there for why.
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
  // A pending deep link into Plan Review (set when the Conversation rail jumps to
  // a step). One-shot: Plan Review reports its own selection back and we drop it,
  // so a later manual pick isn't overridden by a stale target.
  //
  // Still tagged with its session even though a pane is now keyed by session id:
  // the tag costs nothing and keeps the invariant local rather than depending on
  // every caller remembering to key correctly. Step ids are per-plan ordinals
  // (s_01, s_02…) that collide across sessions, so an untagged target that
  // survived a re-key would snap to an unrelated same-numbered step.
  const [target, setTarget] = useState<{ sessionId: string; stepId: string } | null>(null)
  const [split, setSplit] = useState(false)

  const active = props.session
  const planStepTarget = target?.sessionId === active.id ? target.stepId : null

  // What every contribution's `when` and `badge` gets to reason about. Assembled
  // once rather than per tab: `hasPlan` and `diff` are lookups the old if/push
  // chain did inline, and doing them per contribution would repeat them per tab
  // per render.
  const tabCtx: TabContext = {
    session: active,
    hasPlan: props.planSessions?.has(active.id) ?? false,
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
            setTarget(stepId ? { sessionId: session.id, stepId } : null)
            // Already split? Plan Review is on screen — switching tabs would
            // close the transcript the operator just clicked from. Just move
            // its selection.
            if (!ctx.splitOpen) ctx.onSelectTab(BUILTIN_TAB.plan)
          },
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
          ctx.activeTabId === BUILTIN_TAB.plan
            ? "plan"
            : ctx.splitOpen
              ? "split"
              : "conversation",
          paneCtx
        )
      },
      pullRequest: (session, ctx) =>
        props.renderPullRequest?.(session, { onConnectGithub: ctx.onConnectGithub }),
      review: (session, ctx) =>
        props.renderReview?.(session, { onConnectGithub: ctx.onConnectGithub }),
      code: (session, ctx) =>
        props.renderCode?.(session, { onConnectGithub: ctx.onConnectGithub }),
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
  // Plan Review beside the transcript. Derived, never merely stored: a session
  // with no plan has nothing to split, so the same reasoning that hides the Plan
  // tab collapses the split — otherwise a plan-less session would leave an empty
  // column pinned open with no control on screen to close it.
  //
  // …and it now also needs ROOM. The plan column has a 360px floor and never
  // collapsed, so in a 500px pane the transcript beside it was squeezed to about
  // 35px. Below `wide` the split is simply not offered — the Plan Review tab is
  // the same screen at full width, one click away, so nothing is lost but the
  // side-by-side reading the pane couldn't have delivered anyway.
  //
  // The hook is HOISTED out of the `&&` chain. Inline as the third operand it
  // was skipped whenever either of the first two was false, so it ran on some
  // renders and not others — a Rules of Hooks violation that today's React
  // happens to tolerate only because `useContext` doesn't occupy a slot in the
  // hook list. Give `useWidthTier` any internal state (a `useSyncExternalStore`
  // selector, say) and that becomes "rendered fewer hooks than expected". The
  // same rule is spelled out in `issue-view.tsx` and `pull-request-view.tsx`;
  // it applies here too — and `useHookAtTopLevel` now enforces it.
  const roomy = atLeast(useWidthTier(), "wide")
  const splitAvailable =
    activeTab === BUILTIN_TAB.conversation &&
    tabs.some((c) => c.id === BUILTIN_TAB.plan) &&
    roomy
  const splitOpen = split && splitAvailable
  // What this session's agent is doing — drives the tab bar's pill.
  const activeActivity = props.liveActivity?.[active.id] ?? null

  /** What the tab actually on screen is handed. */
  const renderCtx: TabRenderContext = {
    activeTabId: activeTab,
    splitOpen,
    onConnectGithub: connectGithub,
    onSelectTab: setTab
  }

  return (
    <>
      <TabBar
        tabs={tabs.map((c) => describeTab(c, tabCtx))}
        active={activeTab}
        onChange={setTab}
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
        // conversation tab follows a rename the moment it lands.
        sessionTitle={active.title || UNTITLED_SESSION}
        // The chat pills share the tab row, behind a divider. Built by the
        // renderer (RPCs + live activity), threaded in as an opaque node.
        chatSlot={props.renderChatTabs?.(active)}
        // The title comes from the session rather than from the caller, so the
        // chip follows a rename the moment it lands.
        pane={
          props.pane ? { ...props.pane, title: active.title || UNTITLED_SESSION } : undefined
        }
        onToggleBrowser={props.onToggleBrowser}
        browserActive={props.browserActive}
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
          key={`${activeContribution?.mountGroup ?? activeTab}:${active.id}`}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {activeContribution?.render(active, renderCtx)}
        </div>
      </div>
    </>
  )
}
