/**
 * Tab contributions — what a session pane can show, as data.
 *
 * ## Why this exists
 *
 * The tab list used to be a closed union (`"conversation" | "pr" | …`) read by
 * three places that each had to enumerate it again: a `LABEL` map and an `ICON`
 * map in the tab bar, a `META` map in the stub screen, and an if/push chain in
 * the session pane deciding which tabs a session gets. Adding a tab meant
 * finding all four, and *nothing outside this package could add one at all*.
 *
 * A plugin has to be able to. So the union becomes an open registry: a tab is a
 * {@link TabContribution} — an id, how to label it, when it applies, and how to
 * draw it — and the built-in tabs are contributions too, produced by
 * {@link builtinTabContributions}. There is no second code path for plugin tabs,
 * which is the only way to be sure they behave like real ones: if a plugin tab
 * could be second-class, it would be, and the bug would surface as "plugin tabs
 * don't keep their scroll position" three months after anyone remembers why.
 *
 * ## What is deliberately NOT here
 *
 * No React, no session-pane state, no rendering. This module is pure so that
 * `visibleTabs` is trivially testable and so the ordering rules can be checked
 * without mounting anything.
 */
import type { DiffStat, Session } from "@jingler/core"
import { workspaceModeOf } from "@jingler/core"
import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import {
  CircleDot,
  FileDiff,
  FolderTree,
  GitCompareArrows,
  GitPullRequest,
  MessagesSquare,
  Waypoints,
  Workflow
} from "lucide-react"

/**
 * A tab's identity.
 *
 * A plain `string`, not a union, and that widening IS the feature — a plugin's
 * `linear.issues` has to be as valid here as `conversation`. Built-in ids stay
 * bare words for continuity with persisted state and e2e selectors; plugin ids
 * are namespaced `<pluginId>.<local>` and validated at the manifest boundary in
 * `@jingler/core`, so the two can never collide.
 */
export type TabKey = string

/** The built-in tab ids, as constants rather than scattered string literals. */
export const BUILTIN_TAB = {
  conversation: "conversation",
  files: "files",
  issue: "issue",
  plan: "plan",
  pr: "pr",
  review: "review",
  changes: "changes",
  workflow: "workflow"
} as const

export type BuiltinTabKey = (typeof BUILTIN_TAB)[keyof typeof BUILTIN_TAB]

/**
 * Where plugin tabs sort by default.
 *
 * Built-ins occupy 0–99 so a plugin lands after them without having to know
 * their numbers. A plugin that genuinely wants to sit between Conversation and
 * Issue can say so, but the default should never be "shove the operator's
 * familiar tabs to the right".
 */
export const PLUGIN_TAB_ORDER = 100

/**
 * A decoration on a tab — the PR number, the `+N −N` diff totals.
 *
 * Previously two `if (key === …)` branches inside the tab bar, which meant the
 * tab bar knew what a pull request was. Now a contribution computes its own
 * badge and the tab bar just draws whichever shape it gets, so a plugin can
 * badge its tab with an unread count without anyone editing the tab bar.
 */
export type TabBadge =
  | { readonly kind: "count"; readonly text: string }
  | { readonly kind: "diff"; readonly added: number; readonly removed: number }

/**
 * Everything a contribution needs to decide whether it applies and what to
 * badge itself with.
 *
 * `hasPlan` and `diff` are passed rather than read off the session because
 * neither lives there: plan presence is derived from live conversation state,
 * and the diff totals are polled per session. A contribution that had to fetch
 * them itself would fetch them once per tab per render.
 */
export interface TabContext {
  readonly session: Session
  /** Whether this session has a plan worth reviewing. */
  readonly hasPlan: boolean
  /** Live worktree diff totals for this session, if known. */
  readonly diff?: DiffStat | null
}

/** What a contribution is handed when it is the tab actually on screen. */
export interface TabRenderContext {
  /** The tab currently selected — a contribution in a shared mount group
   *  uses this to pick which face to show. */
  readonly activeTabId: TabKey
  /** Whether the plan is currently split beside the conversation. */
  readonly splitOpen: boolean
  /** Open Settings — the "connect GitHub" escape hatch on empty states. */
  readonly onConnectGithub: () => void
  /** Switch this pane to another tab, e.g. deep-linking into Plan Review. */
  readonly onSelectTab: (id: TabKey) => void
}

/**
 * One tab, as data.
 *
 * `render` returning a `ReactNode` rather than a component type is deliberate:
 * the built-in tabs are closures over the host's `render*` callbacks, and
 * forcing them into components would mean a new component identity on every
 * render and a full remount of the transcript on every keystroke.
 */
export interface TabContribution {
  readonly id: TabKey
  readonly label: string
  readonly icon: LucideIcon
  /** Lower sorts earlier. Built-ins 0–99; plugins default to {@link PLUGIN_TAB_ORDER}. */
  readonly order: number
  /** Whether this tab applies to the session in `ctx`. Must be cheap and pure. */
  readonly when: (ctx: TabContext) => boolean
  /** Optional decoration drawn beside the label. */
  readonly badge?: (ctx: TabContext) => TabBadge | undefined
  /**
   * Tabs sharing a mount group share ONE mounted subtree and swap faces
   * internally instead of unmounting. Defaults to the tab's own id, i.e. "I
   * unmount when you switch away from me" — which is what almost every tab
   * wants, and what the virtualized transcript REQUIRES of its neighbours (its
   * measurement cache corrupts if it is kept mounted-but-hidden).
   *
   * Conversation and Plan Review share one, because switching to Plan must not
   * unmount — and so abort — a parked plan run.
   */
  readonly mountGroup?: string
  readonly render: (session: Session, ctx: TabRenderContext) => ReactNode
}

/** What the tab bar needs to draw one tab. Presentation only — no behaviour. */
export interface TabDescriptor {
  readonly id: TabKey
  readonly label: string
  readonly icon: LucideIcon
  readonly badge?: TabBadge
}

/**
 * The tabs that apply to a session, in display order.
 *
 * Replaces the old if/push chain. Two properties matter and are tested:
 *
 * - **Deterministic order.** Sorted by `order`, ties broken by id, so two
 *   plugins that both default to 100 do not swap places between renders
 *   depending on which finished loading first.
 * - **A throwing `when` is skipped, not fatal.** `when` is third-party code
 *   evaluated during render; letting it take the pane down would mean one
 *   careless plugin blanks the app. It loses its tab and nothing else.
 */
export const visibleTabs = (
  ctx: TabContext | null,
  contributions: ReadonlyArray<TabContribution>
): ReadonlyArray<TabContribution> => {
  if (!ctx) return []
  return contributions
    .filter((c) => {
      try {
        return c.when(ctx)
      } catch {
        return false
      }
    })
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Fold a contribution into what the tab bar draws. */
export const describeTab = (
  contribution: TabContribution,
  ctx: TabContext
): TabDescriptor => {
  let badge: TabBadge | undefined
  try {
    badge = contribution.badge?.(ctx)
  } catch {
    // Same reasoning as `when`: a plugin's badge maths must not take down the
    // tab bar. The tab still renders, just undecorated.
    badge = undefined
  }
  return {
    id: contribution.id,
    label: contribution.label,
    icon: contribution.icon,
    ...(badge ? { badge } : {})
  }
}

// ── The built-in tabs ────────────────────────────────────────────────────────

/**
 * Presentation for the built-in tabs — the single home for what used to be the
 * tab bar's `LABEL` and `ICON` maps and the stub screen's `META` map.
 *
 * `blurb` is what the not-yet-built placeholder shows. Keeping it here rather
 * than in the stub screen means a tab is described in exactly one place whether
 * it is implemented or not.
 */
export const BUILTIN_TAB_META: Record<
  BuiltinTabKey,
  { label: string; icon: LucideIcon; order: number; blurb?: string }
> = {
  conversation: { label: "Conversation", icon: MessagesSquare, order: 0 },
  files: {
    label: "Files",
    icon: FolderTree,
    order: 15,
    blurb: "Browse, inspect, and edit files in this session's worktree."
  },
  // Kept for the stub screen and for continuity of the id, but no longer a
  // built-in contribution: the Issue tab ships as the `github-issues` plugin,
  // which claims the same order so the migration is invisible to anyone who was
  // already using it.
  issue: { label: "Issue", icon: CircleDot, order: 10 },
  plan: {
    label: "Plan Review",
    icon: Waypoints,
    order: 20,
    blurb:
      "Visualise the plan, step through flow control, annotate and gate steps."
  },
  pr: {
    label: "Pull Request",
    icon: GitPullRequest,
    order: 30,
    blurb: "CI status, review timeline and the agent feedback loop."
  },
  review: {
    label: "Code Review",
    icon: GitCompareArrows,
    order: 40,
    blurb: "Select lines, comment, and route changes back to the agent."
  },
  changes: {
    label: "Changes",
    icon: FileDiff,
    order: 40,
    blurb: "The session worktree's local uncommitted diff."
  },
  workflow: {
    label: "Workflow",
    icon: Workflow,
    order: 50,
    blurb:
      "Deterministic multi-agent runs — Build → Review → Reconcile across worktrees."
  }
}

/** A descriptor for a built-in tab, for stories and tests that only draw a bar. */
export const builtinDescriptor = (
  id: BuiltinTabKey,
  badge?: TabBadge
): TabDescriptor => ({
  id,
  label: BUILTIN_TAB_META[id].label,
  icon: BUILTIN_TAB_META[id].icon,
  ...(badge ? { badge } : {})
})

/** The render callbacks the host supplies for the built-in tab bodies. */
export interface BuiltinTabRenderers {
  readonly conversation: (
    session: Session,
    ctx: TabRenderContext
  ) => ReactNode
  readonly files?: (session: Session, ctx: TabRenderContext) => ReactNode
  readonly pullRequest?: (session: Session, ctx: TabRenderContext) => ReactNode
  readonly review?: (session: Session, ctx: TabRenderContext) => ReactNode
  readonly code?: (session: Session, ctx: TabRenderContext) => ReactNode
  /** Drawn for any built-in tab with no renderer wired — stories, milestones. */
  readonly stub: (id: BuiltinTabKey) => ReactNode
}

/**
 * The built-in tabs as contributions.
 *
 * Every visibility rule that used to live in `visibleTabs`'s if/push chain is
 * now a `when` on the contribution it belongs to, which is why the chain could
 * be deleted rather than merely moved. Two of them are worth restating because
 * they are not obvious:
 *
 * - **Pull Request shows before a PR exists** (any session with a worktree), so
 *   the "Create pull request" empty state is reachable at all.
 * - **Changes and Code Review are mutually exclusive.** Once a PR exists, Code
 *   Review covers the local diff too, and showing both would put the same diff
 *   behind two tabs with different affordances.
 */
export const builtinTabContributions = (
  renderers: BuiltinTabRenderers
): ReadonlyArray<TabContribution> => {
  const meta = BUILTIN_TAB_META
  /** Conversation and Plan are one mounted subtree — see `mountGroup`. */
  const CONVERSATION_GROUP = "conversation"

  return [
    {
      id: BUILTIN_TAB.conversation,
      ...meta.conversation,
      when: () => true,
      mountGroup: CONVERSATION_GROUP,
      render: renderers.conversation
    },
    {
      id: BUILTIN_TAB.files,
      ...meta.files,
      when: ({ session }) => session.worktreePath != null,
      render: (session, ctx) =>
        renderers.files?.(session, ctx) ?? renderers.stub("files")
    },
    {
      id: BUILTIN_TAB.plan,
      ...meta.plan,
      // Always present for a worktree-backed session, so the operator can open
      // it and author a plan for the agent before any run has proposed one. The
      // PlanReview screen renders a "Start a plan" empty state when none exists.
      when: ({ session }) => session.worktreePath != null,
      mountGroup: CONVERSATION_GROUP,
      render: renderers.conversation
    },
    {
      id: BUILTIN_TAB.pr,
      ...meta.pr,
      when: ({ session }) =>
        session.prNumber != null ||
        (session.worktreePath != null &&
          workspaceModeOf(session) === "worktree"),
      badge: ({ session }) =>
        session.prNumber != null
          ? { kind: "count", text: `#${session.prNumber}` }
          : undefined,
      render: (session, ctx) =>
        renderers.pullRequest?.(session, ctx) ?? renderers.stub("pr")
    },
    {
      id: BUILTIN_TAB.review,
      ...meta.review,
      when: ({ session }) => session.prNumber != null,
      render: (session, ctx) =>
        renderers.review?.(session, ctx) ?? renderers.stub("review")
    },
    {
      id: BUILTIN_TAB.changes,
      ...meta.changes,
      when: ({ session }) =>
        session.prNumber == null && session.worktreePath != null,
      badge: ({ diff }) =>
        diff && diff.added + diff.removed > 0
          ? { kind: "diff", added: diff.added, removed: diff.removed }
          : undefined,
      render: (session, ctx) =>
        renderers.code?.(session, ctx) ?? renderers.stub("changes")
    }
  ]
}
