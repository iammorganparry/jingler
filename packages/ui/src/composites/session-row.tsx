import { useEffect, useState } from "react"
import type { DragEvent, ReactNode } from "react"
import { motion } from "motion/react"
import { SPRING } from "../lib/motion.js"
import { SESSION_DND_MIME } from "../app/split-layout.js"
import type { Environment, SessionPrStatus, Session, SessionActivity } from "@jingler/core"
import { activityLabel, displayStatusOf, persistentOf } from "@jingler/core"
import {
  Archive,
  ArchiveRestore,
  Cloud,
  GitMerge,
  Monitor,
  Pin,
  type LucideIcon,
  Trash2
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { PrStatusGlyph } from "./pr-glyph.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { ThinkingOrb } from "../components/loading.js"
import { ProviderIcon, PROVIDER_LABEL } from "../components/provider-icon.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { displayStatusLabel, displayStatusTone, statusTextClass } from "../tokens.js"

const compactAge = (startedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function RepoMark({ repo, owner }: { readonly repo: string; readonly owner?: string }) {
  const name = repo.split("/").filter(Boolean).at(-1) ?? repo
  return (
    <span
      title={`Repository: ${repo}`}
      data-repo-owner={owner}
      className="flex size-4 flex-none items-center justify-center rounded-full font-mono text-[8px] font-bold uppercase text-text-bright shadow-[0_0_0_1px_var(--sb-line)]"
      aria-hidden
    >
      <Avatar
        initial={name.slice(0, 1)}
        src={owner ? githubAvatarUrl(owner, 32) : null}
        tone="dim"
        size={16}
      />
    </span>
  )
}

/** A session row for the sidebar list. Active state gets the blue ring. */
export function SessionRow({
  session,
  environment,
  repoOwner,
  activity,
  prState,
  active = false,
  onSelect,
  onRename,
  onSetPersistent,
  onArchive,
  onRestore,
  onDelete,
  slotIndex = null,
  className
}: {
  session: Session
  environment?: Environment
  /** GitHub owner login resolved from this session's repository origin. */
  repoOwner?: string
  /**
   * What the agent is doing right now ("Running npm test"). Absent → the row
   * falls back to the persisted `session.status`.
   */
  activity?: SessionActivity
  /**
   * Live state of the session's linked PR. A merged/closed PR badges the row
   * rather than retiring the session: one session can outlive several PRs (open
   * one, merge it, open the next off the same worktree), so merging PR #204 says
   * nothing about whether the WORK is done. Archiving is the operator's call.
   */
  /**
   * The linked PR's state + CI rollup, driving the row's leading glyph. Absent
   * (or null) for a session with no PR, which renders a hollow ring.
   */
  prState?: SessionPrStatus | null
  active?: boolean
  onSelect?: (id: string) => void
  /** Manual rename (double-click the title) — pins the auto-generated name. */
  onRename?: (id: string, title: string) => void
  /** Promote an active ordinary row into the persistent tray. */
  onSetPersistent?: (id: string, persistent: boolean) => void
  /** Archive an active session (collapses into the Archived group; undoable). */
  onArchive?: (id: string) => void | Promise<void>
  /** Restore an archived session back to active. */
  onRestore?: (id: string) => void
  /** Permanently delete a session (the caller confirms first). */
  onDelete?: (id: string) => void | Promise<void>
  /**
   * Which grid slot this session currently occupies, or null when it isn't on
   * screen. Drives the numbered badge — the answer to "where did that one go?"
   * when four sessions are live at once.
   */
  slotIndex?: number | null
  className?: string
}) {
  // One rollup, three jobs: what the row says, what colour it says it in, and
  // whether it dims. The label is one of five words — never the tool or target.
  const display = displayStatusOf(activity, session.status)
  const status = displayStatusTone[display]
  const label = displayStatusLabel[display]
  // The detail the label no longer shows ("Running npm test -- auth") survives on
  // hover. It's genuinely useful when you want it, and it was the reason the
  // label used to be unbounded — a title attribute gives it a home that can't
  // push the branch name out of the row.
  const detail = activity ? activityLabel(activity) : label
  const [draft, setDraft] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<"archive" | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const activeStartedAt =
    activity?.startedAt ?? (idleStatus(display) ? null : Date.parse(session.updatedAt))
  useEffect(() => {
    if (activeStartedAt === null || Number.isNaN(activeStartedAt)) return
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(tick)
  }, [activeStartedAt])

  const runArchive = () => {
    if (onArchive === undefined || pendingAction !== null) return
    setPendingAction("archive")
    void Promise.resolve(onArchive(session.id))
      .catch(() => {})
      .finally(() => setPendingAction(null))
  }

  // Quick actions — archive/restore + delete — surfaced on hover and via a
  // right-click context menu. The action set depends on whether it's archived.
  const actions: ContextMenuItem[] = pendingAction !== null ? [] : [
    ...(!session.archived && !persistentOf(session) && onSetPersistent
      ? [
          {
            label: "Persist",
            icon: Pin,
            onSelect: () => onSetPersistent(session.id, true)
          }
        ]
      : []),
    ...(session.archived
      ? onRestore
        ? [
            {
              label: "Restore",
              icon: ArchiveRestore,
              onSelect: () => onRestore(session.id)
            }
          ]
        : []
      : onArchive
        ? [
            {
              label: "Archive",
              icon: Archive,
              onSelect: runArchive
            }
          ]
        : []),
    ...(onDelete
      ? [
          {
            label: "Delete",
            icon: Trash2,
            tone: "danger" as const,
            separated: true,
            onSelect: () => onDelete(session.id)
          }
        ]
      : [])
  ]

  const hoverActions = (actions.length > 0 || pendingAction !== null) && (
    <div
      className="absolute right-1.5 top-1.5 z-10 hidden items-center gap-0.5 rounded-md bg-panel/90 group-hover:flex"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Names include the title so icon-only buttons are unambiguous for screen
          readers and never collide with the archived-session banner's controls. */}
      {pendingAction !== null ? (
        <ThinkingOrb compact label="Archiving session…" className="p-0.5" />
      ) : session.archived
        ? onRestore && (
            <RowAction
              icon={ArchiveRestore}
              label={`Restore ${session.title}`}
              onClick={() => onRestore(session.id)}
            />
          )
        : onArchive && (
            <RowAction
              icon={Archive}
              label={`Archive ${session.title}`}
              onClick={runArchive}
            />
          )}
      {onDelete && pendingAction === null && (
        <RowAction
          icon={Trash2}
          label={`Delete ${session.title}`}
          danger
          onClick={() => onDelete(session.id)}
        />
      )}
    </div>
  )

  // Wrap the row in a right-click menu only when there's at least one action.
  const withMenu = (node: ReactNode) =>
    actions.length > 0 ? <ContextMenu items={actions}>{node}</ContextMenu> : node

  /**
   * Drag props shared by both row variants. The row is the drag SOURCE for the
   * session grid; the slots downstream are the targets.
   *
   * `effectAllowed = "copyMove"` because a drop doesn't remove the session from
   * the sidebar — the row stays put and simply gains a slot badge.
   */
  const dragProps = {
    // Never while renaming: in Chromium a `draggable` ancestor swallows
    // press-and-drag inside a descendant text input, so selecting part of the
    // title would start dragging the row instead.
    draggable: draft === null && pendingAction === null,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(SESSION_DND_MIME, session.id)
      e.dataTransfer.effectAllowed = "copyMove"
    }
  }

  /**
   * The numbered badge marking a session that's live in the grid. 1-based for
   * display — the operator counts panes from one, even though slots are indexed
   * from zero everywhere in the model.
   */
  const slotBadge =
    slotIndex == null ? null : (
      <span
        data-testid={`session-slot-badge-${session.id}`}
        title={`Showing in pane ${slotIndex + 1}`}
        className="flex-none"
      >
        {/* Blue, unlike the neutral `count` badges beside it: this one says "on
            screen right now", which is a different kind of fact from a PR number. */}
        <Badge tone="blue" size="xs">
          {slotIndex + 1}
        </Badge>
      </span>
    )

  const commit = () => {
    if (draft === null) return
    const next = draft.trim()
    if (next.length > 0 && next !== session.title) onRename?.(session.id, next)
    setDraft(null)
  }

  // Archived variant (A2 in the design): purple git-merge mark, muted title, a
  // Merged/Closed pill, and how long ago it was archived. Read-only — no status.
  if (session.archived) {
    const closed = session.archiveReason === "closed"
    return withMenu(
      <div
        data-testid={`session-row-${session.id}`}
        {...dragProps}
        onClick={() => pendingAction === null && onSelect?.(session.id)}
        aria-busy={pendingAction !== null}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-[6px] rounded-lg border px-2.5 py-2 transition-colors",
          active ? "border-blue/[0.32] bg-surface" : "border-transparent hover:bg-surface/40",
          className
        )}
      >
        {hoverActions}
        <div className="flex items-center gap-2">
          <GitMerge size={13} className={cn("flex-none", closed ? "text-red" : "text-purple")} />
          <span
            className={cn(
              "flex-1 truncate text-[13px]",
              active ? "font-medium text-text" : "text-muted-foreground"
            )}
          >
            {session.title}
          </span>
          {slotBadge}
        </div>
        <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
          <Badge tone={closed ? "red" : "purple"} size="sm">
            {closed ? "Closed" : "Merged"}
            {session.prNumber !== null ? ` #${session.prNumber}` : ""}
          </Badge>
          <div className="flex-1" />
          {session.archivedAt && <span>{relativeTime(session.archivedAt)}</span>}
        </div>
      </div>
    )
  }

  // Off the display rollup, not the raw status, so the row that SAYS "Idle" is
  // the row that dims — including a "done" session, which folds to idle.
  const idle = display === "idle"
  const age =
    activeStartedAt !== null && !Number.isNaN(activeStartedAt)
      ? compactAge(activeStartedAt, now)
      : null
  const executionLocation = session.environmentId ? "cloud" : (session.executionLocation ?? "local")
  return withMenu(
    // The motion element is a WRAPPER rather than the row itself because
    // `motion.div` claims `onDragStart` for its own pan gesture, whose signature
    // is incompatible with the HTML5 drag handler this row needs to be a drag
    // source. Wrapping keeps both: motion owns the box, the inner div owns the
    // drag.
    //
    // `layoutId` pairs this row with the same session's SEGMENT inside a
    // `SplitRow` pill. When the session is dragged into a split (or separated
    // back out) `motion` matches the two elements across the unmount and tweens
    // between their boxes, so the row visibly travels into the pill instead of
    // vanishing here and appearing there. The id must match `split-row.tsx`.
    //
    // An ARCHIVED row carries no id at all. Archiving evicts a session from its
    // split (see the prune in `use-split-layout`), so an archived row has no
    // segment left to morph with — and an id with no counterpart is pure risk:
    // if a stale persisted workspace ever named an archived session, both
    // elements would mount with the same id for a frame, which is undefined in
    // motion and can snap either one to the other's box.
    <motion.div
      layoutId={session.archived ? undefined : `session-${session.id}`}
      layout
      transition={SPRING}
    >
      <div
        data-testid={`session-row-${session.id}`}
        {...dragProps}
        onClick={() => pendingAction === null && onSelect?.(session.id)}
        aria-busy={pendingAction !== null}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-[7px] rounded-lg border px-2.5 py-2 transition-colors",
          active ? "border-blue/[0.32] bg-surface" : "border-transparent hover:bg-surface/40",
          idle && !active && "opacity-55",
          pendingAction !== null && "cursor-wait opacity-60",
          className
        )}
      >
        {hoverActions}
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <RepoMark repo={session.repo} owner={repoOwner} />
          <span className="min-w-0 flex-1 truncate font-medium">{session.repo}</span>
          <span
            title={detail}
            className={cn("flex flex-none items-center gap-1 font-medium tabular-nums", statusTextClass[status])}
          >
            {display === "thinking" || display === "running" ? (
              <ThinkingOrb compact label={label} />
            ) : null}
            {label}
            {age ? ` ${age}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {draft !== null ? (
            <input
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit()
                else if (e.key === "Escape") setDraft(null)
              }}
              onBlur={commit}
              className="flex-1 rounded border border-blue/50 bg-editor px-1 py-px text-[13px] text-text-bright outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (onRename) setDraft(session.title)
              }}
              title={onRename ? "Double-click to rename" : undefined}
              className={cn(
                "flex-1 truncate text-[13px]",
                active ? "font-semibold text-text-bright" : "font-medium text-text"
              )}
            >
              {session.title}
            </span>
          )}
          {slotBadge}
        </div>
        <div className="flex items-center gap-[7px] font-mono text-[10.5px] text-muted-foreground">
          <span className={cn("min-w-0 truncate", active ? "text-blue" : "text-muted-foreground")}>
            {session.branch}
          </span>
          {session.issueNumber != null && (
            <span className="flex-none text-green">#{session.issueNumber}</span>
          )}
          {session.prNumber !== null && (
            <span
              className="flex flex-none items-center gap-1"
              title={`Pull request #${session.prNumber}`}
            >
              <PrStatusGlyph pr={prState} />
              <span>#{session.prNumber}</span>
            </span>
          )}
          <div className="flex-1" />
          {environment && (
            <span data-testid={`session-environment-${session.id}`} className="max-w-[96px] truncate text-dim" title={`${environment.name} · ${environment.state}`}>
              {environment.name}{environment.state === "online" ? "" : ` · ${environment.state}`}
            </span>
          )}
          {(session.diff.added > 0 || session.diff.removed > 0) && (
            <DiffStat added={session.diff.added} removed={session.diff.removed} />
          )}
          <span
            data-testid={`session-location-${session.id}`}
            title={environment ? `Environment: ${environment.name} · ${environment.state}` : session.environmentId ? `Environment: ${session.environmentId}` : executionLocation === "cloud" ? "Cloud session" : "Local session"}
            className="flex size-4 flex-none items-center justify-center text-dim"
          >
            {executionLocation === "cloud" ? <Cloud size={12} /> : <Monitor size={12} />}
          </span>
          <span
            title={`${PROVIDER_LABEL[session.cli]} harness`}
            className="flex size-4 flex-none items-center justify-center"
          >
            <ProviderIcon cli={session.cli} size={12} />
          </span>
        </div>
      </div>
    </motion.div>
  )
}

const idleStatus = (status: ReturnType<typeof displayStatusOf>): boolean => status === "idle"

/** A compact icon button in a row's hover action bar. */
function RowAction({
  icon: Icon,
  label,
  danger = false,
  onClick
}: {
  icon: LucideIcon
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        danger
          ? "text-muted-foreground hover:bg-red/10 hover:text-red"
          : "text-muted-foreground hover:bg-surface hover:text-text-bright"
      )}
    >
      <Icon size={13} />
    </button>
  )
}
