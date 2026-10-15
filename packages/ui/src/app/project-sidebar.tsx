import { displayStatusOf, type Project, type Session, type SessionActivity } from "@jingler/core"
import { useState } from "react"
import { FolderCog, FolderSearch, FolderX, Import, Plus, Trash2 } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { ContextMenu, type ContextMenuItem } from "../components/context-menu.js"
import { HoverCard } from "../components/hover-card.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"
import { JinglerMark } from "../brand/jingler-mark.js"
import { projectIdForSession, UNASSIGNED_PROJECT_ID } from "./project-navigation.js"

/** Live activity kinds that mean the run is blocked on the operator. */
const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(["needs-input", "needs-approval"])

type ProjectItem = Pick<Project, "id" | "name" | "availability"> & { readonly path?: string }

/** Tile menu rows; a missing folder adds a status row plus Locate ahead of Settings / Remove. */
function tileMenuItems(
  project: ProjectItem,
  actions: { onOpenSettings?: () => void; onLocate?: () => void; onRemove?: () => void }
): ContextMenuItem[] {
  const { onOpenSettings, onLocate, onRemove } = actions
  return [
    ...(onLocate ? [
      { label: "Folder not found", icon: FolderX, disabled: true, onSelect: () => {} },
      { label: "Locate folder…", icon: FolderSearch, onSelect: onLocate }
    ] : []),
    ...(onOpenSettings ? [{ label: "Settings", icon: FolderCog, onSelect: onOpenSettings }] : []),
    ...(onRemove ? [{ label: "Remove project", icon: Trash2, tone: "danger" as const, separated: true, onSelect: onRemove }] : [])
  ]
}

/** Sidebar notice for the selected project whose folder is gone (neutral, spec §6.3). */
export function MissingFolderBanner({
  project,
  onLocate
}: {
  project?: Pick<Project, "id" | "name" | "availability">
  onLocate?: (projectId: string) => void | Promise<void>
}) {
  if (project?.availability !== "missing") return null
  return (
    <BannerShell
      placement="lane"
      icon={<FolderX size={14} />}
      actions={onLocate ? [
        <Button key="locate" size="sm" variant="secondary" onClick={() => void onLocate(project.id)}>Locate folder…</Button>
      ] : undefined}
    >
      {project.name}: folder not found
    </BannerShell>
  )
}

function ProjectAvatar({
  project,
  owner,
  active,
  sessionCount,
  activeSessionCount,
  needsYouCount,
  onSelect,
  onOpenSettings,
  onLocate,
  onRemove
}: {
  project: ProjectItem
  owner?: string
  active: boolean
  sessionCount: number
  activeSessionCount: number
  /** Sessions blocked on the operator (question or approval); drives the amber top-right badge. */
  needsYouCount: number
  onSelect: () => void
  onOpenSettings?: () => void
  onLocate?: () => void
  onRemove?: () => void | Promise<void>
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const items = tileMenuItems(project, { onOpenSettings, onLocate, onRemove: onRemove && (() => setConfirmingRemove(true)) })
  const tile = (
    <HoverCard
      delayMs={120}
      content={
        <div className="w-56 p-3">
          <div className="font-semibold text-text-bright">{project.name}</div>
          {project.path ? (
            <div className="mt-1 truncate font-mono text-[10px] text-dim" title={project.path}>{project.path}</div>
          ) : null}
          <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground">
            <span>{sessionCount} open session{sessionCount === 1 ? "" : "s"}</span>
            {activeSessionCount > 0 ? <span className="text-text-bright">{activeSessionCount} active</span> : null}
            {needsYouCount > 0 ? <span className="text-yellow">{needsYouCount} need you</span> : null}
          </div>
        </div>
      }
    >
      <button
        type="button"
        data-testid={`project-row-${project.id}`}
        aria-label={project.name}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "group relative flex size-9 flex-none items-center justify-center rounded-[8px] border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          active ? "border-transparent bg-surface" : "border-hairline bg-editor hover:bg-surface/60"
        )}
      >
        {active ? <span aria-hidden className="absolute -left-[10px] h-5 w-[2px] bg-text-bright" /> : null}
        <Avatar
          initial={project.name.slice(0, 1).toUpperCase()}
          src={owner ? githubAvatarUrl(owner, 40) : null}
          tone="dim"
          size={28}
          className="rounded-[6px]"
        />
        <span
          aria-hidden
          className={cn(
            "absolute -top-[5px] flex h-4 min-w-4 items-center justify-center rounded-full whitespace-nowrap bg-line-strong px-1 text-[11px] font-semibold leading-[14px] text-text-bright ring-2 ring-canvas",
            // The amber needs-you badge owns the top-right corner; the session count yields to the left.
            needsYouCount > 0 ? "-left-[5px]" : "-right-[5px]"
          )}
        >
          {sessionCount}
        </span>
        {needsYouCount > 0 ? (
          <span
            role="status"
            data-testid={`project-needs-you-${project.id}`}
            aria-label={`${project.name}: ${needsYouCount} need${needsYouCount === 1 ? "s" : ""} you`}
            className="absolute -right-[5px] -top-[5px] flex rounded-full ring-2 ring-canvas"
          >
            <Badge tone="yellow" size="xs" className="h-4 min-w-4 justify-center rounded-full px-1">{needsYouCount}</Badge>
          </span>
        ) : null}
        {activeSessionCount > 0 ? (
          <span role="status" aria-label={`${project.name}: sessions in progress`} className="absolute -bottom-[3px] -right-[3px] flex rounded-full ring-2 ring-canvas">
            <StatusDot tone="bg-state-working" pulse size={8} />
          </span>
        ) : null}
        {project.availability !== "available" ? (
          <span aria-hidden className="absolute -bottom-[3px] -left-[3px] size-2 rounded-full bg-muted-foreground ring-2 ring-canvas" />
        ) : null}
      </button>
    </HoverCard>
  )
  if (items.length === 0) return tile
  return (
    <>
      {/* A real box (not `contents`) so the keyboard-opened menu anchors to the tile; focus
          returning to it is handed straight to the button. */}
      <ContextMenu items={items}>
        <div
          tabIndex={-1}
          className="flex-none outline-none"
          onFocus={(event) => {
            if (event.target === event.currentTarget) event.currentTarget.querySelector("button")?.focus()
          }}
        >
          {tile}
        </div>
      </ContextMenu>
      {onRemove ? (
        <ConfirmDialog
          open={confirmingRemove}
          onOpenChange={setConfirmingRemove}
          destructive
          title={`Remove ${project.name}?`}
          description="This unregisters the project from Jingler. Files on disk are not deleted."
          confirmLabel="Remove project"
          onConfirm={onRemove}
        />
      ) : null}
    </>
  )
}

export function ProjectSidebar({
  projects,
  sessions,
  activeProjectId,
  liveActivity,
  projectOwners,
  loading = false,
  onSelect,
  onAddProject,
  onImportSessions,
  onOpenSettings,
  onLocate,
  onRemove
}: {
  projects: ReadonlyArray<Project>
  sessions: ReadonlyArray<Session>
  activeProjectId: string
  liveActivity?: Readonly<Record<string, SessionActivity>>
  projectOwners?: Readonly<Record<string, string>>
  loading?: boolean
  onSelect: (projectId: string) => void
  onAddProject?: () => void
  onImportSessions?: () => void
  /** Rail tile context menu: open that project's settings. */
  onOpenSettings?: (projectId: string) => void
  /** Rail tile context menu (missing folders only): pick the folder again. */
  onLocate?: (projectId: string) => void | Promise<void>
  /** Rail tile context menu: unregister the project (confirmed first). */
  onRemove?: (projectId: string) => void | Promise<void>
}) {
  const openSessions = sessions.filter((session) => !session.archived)
  const hasUnassigned = openSessions.some(
    (session) => projectIdForSession(session, projects) === UNASSIGNED_PROJECT_ID
  )
  const candidates: ReadonlyArray<ProjectItem> = hasUnassigned
    ? [...projects, { id: UNASSIGNED_PROJECT_ID, name: "Unassigned", availability: "available" }]
    : projects
  const items = candidates
    .map((project) => ({
      project,
      sessions: openSessions.filter(
        (session) => projectIdForSession(session, projects) === project.id
      )
    }))
    .sort((a, b) => b.sessions.length - a.sessions.length)

  return (
    <nav
      aria-label="Projects"
      data-testid="project-sidebar"
      aria-busy={loading}
      className="flex w-14 flex-none flex-col items-center border-r border-hairline bg-canvas py-2"
    >
      <JinglerMark className="mb-2 h-4 w-auto flex-none text-muted-foreground" />
      <div className="sb-no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pt-1">
        {loading
          ? [0, 1, 2].map((index) => (
              <span
                key={index}
                data-testid="project-skeleton"
                className="size-9 flex-none animate-pulse rounded-[8px] bg-surface"
              />
            ))
          : items.map(({ project, sessions: projectSessions }) => (
              <ProjectAvatar
                key={project.id}
                project={project}
                owner={projectOwners?.[project.id]}
                active={activeProjectId === project.id}
                sessionCount={projectSessions.length}
                activeSessionCount={projectSessions.filter((session) =>
                  ["running", "thinking"].includes(displayStatusOf(liveActivity?.[session.id], session.status))
                ).length}
                needsYouCount={projectSessions.filter((session) =>
                  NEEDS_YOU_KINDS.has(liveActivity?.[session.id]?.kind ?? "")
                ).length}
                onSelect={() => onSelect(project.id)}
                onOpenSettings={
                  onOpenSettings && project.id !== UNASSIGNED_PROJECT_ID
                    ? () => onOpenSettings(project.id)
                    : undefined
                }
                onLocate={
                  onLocate && project.availability === "missing" && project.id !== UNASSIGNED_PROJECT_ID
                    ? () => void onLocate(project.id)
                    : undefined
                }
                onRemove={
                  onRemove && project.id !== UNASSIGNED_PROJECT_ID
                    ? () => onRemove(project.id)
                    : undefined
                }
              />
            ))}
      </div>
      {onAddProject ? (
        <button
          type="button"
          aria-label="Add project"
          title="Add project"
          onClick={onAddProject}
          className="mt-2 flex size-9 flex-none items-center justify-center rounded-[8px] border border-dashed border-line text-dim outline-none hover:border-line-strong hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus size={16} />
        </button>
      ) : null}
      {onImportSessions ? (
        <button
          type="button"
          aria-label="Import sessions…"
          title="Import sessions…"
          onClick={onImportSessions}
          className="mt-2 flex size-9 flex-none items-center justify-center rounded-[8px] border border-dashed border-line text-dim outline-none hover:border-line-strong hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Import size={16} />
        </button>
      ) : null}
    </nav>
  )
}
