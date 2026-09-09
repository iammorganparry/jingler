import type { Project, Session } from "@jingler/core"
import { Plus } from "lucide-react"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { HoverCard } from "../components/hover-card.js"
import { cn } from "../lib/cn.js"
import { JinglerMark } from "../brand/jingler-mark.js"
import { projectIdForSession, UNASSIGNED_PROJECT_ID } from "./project-navigation.js"

type ProjectItem = Pick<Project, "id" | "name" | "availability"> & { readonly path?: string }

function ProjectAvatar({
  project,
  owner,
  active,
  sessionCount,
  activeSessionCount,
  onSelect
}: {
  project: ProjectItem
  owner?: string
  active: boolean
  sessionCount: number
  activeSessionCount: number
  onSelect: () => void
}) {
  return (
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
            {activeSessionCount > 0 ? <span className="text-green">{activeSessionCount} active</span> : null}
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
          "group relative flex size-10 flex-none items-center justify-center rounded-xl outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
          active ? "rounded-[14px] bg-surface" : "hover:rounded-[14px] hover:bg-surface/60"
        )}
      >
        {active ? <span aria-hidden className="absolute -left-2 h-5 w-[3px] rounded-r-full bg-blue" /> : null}
        <Avatar
          initial={project.name.slice(0, 1).toUpperCase()}
          src={owner ? githubAvatarUrl(owner, 40) : null}
          tone="dim"
          size={32}
          className="rounded-[10px]"
        />
        <span
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-panel"
        >
          {sessionCount}
        </span>
        {project.availability !== "available" ? (
          <span className="absolute bottom-0 right-0 size-2 rounded-full bg-yellow ring-2 ring-panel" />
        ) : null}
      </button>
    </HoverCard>
  )
}

export function ProjectSidebar({
  projects,
  sessions,
  activeProjectId,
  projectOwners,
  loading = false,
  onSelect,
  onAddProject
}: {
  projects: ReadonlyArray<Project>
  sessions: ReadonlyArray<Session>
  activeProjectId: string
  projectOwners?: Readonly<Record<string, string>>
  loading?: boolean
  onSelect: (projectId: string) => void
  onAddProject?: () => void
}) {
  const openSessions = [...sessions]
    .filter((session) => !session.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
    .filter(({ sessions: projectSessions }) => projectSessions.length > 0)
    .sort(
      (a, b) =>
        Number(b.project.id === activeProjectId) - Number(a.project.id === activeProjectId) ||
        b.sessions[0]!.updatedAt.localeCompare(a.sessions[0]!.updatedAt)
    )

  return (
    <nav
      aria-label="Projects"
      data-testid="project-sidebar"
      aria-busy={loading}
      className="flex w-[60px] flex-none flex-col items-center border-r border-hairline bg-panel py-2"
    >
      <JinglerMark className="mb-2 h-5 w-auto flex-none text-brand" />
      <div className="sb-no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2">
        {loading
          ? [0, 1, 2].map((index) => (
              <span
                key={index}
                data-testid="project-skeleton"
                className="size-10 flex-none animate-pulse rounded-xl bg-surface"
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
                  ["running", "thinking", "needs-input"].includes(session.status)
                ).length}
                onSelect={() => onSelect(project.id)}
              />
            ))}
      </div>
      {onAddProject ? (
        <button
          type="button"
          aria-label="Add project"
          title="Add project"
          onClick={onAddProject}
          className="mt-2 flex size-10 flex-none items-center justify-center rounded-xl border border-dashed border-line text-dim hover:border-blue hover:bg-surface hover:text-text"
        >
          <Plus size={17} />
        </button>
      ) : null}
    </nav>
  )
}
