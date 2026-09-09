import type { Project, Session } from "@jingler/core"

export const UNASSIGNED_PROJECT_ID = "__unassigned__"

export function projectIdForSession(
  session: Session,
  projects: ReadonlyArray<Project>
): string {
  if (session.projectId && projects.some((project) => project.id === session.projectId)) {
    return session.projectId
  }

  const matches = projects.filter(
    (project) =>
      project.environmentId === session.environmentId &&
      (project.path === session.repoPath || (!session.repoPath && project.name === session.repo))
  )
  return matches.length === 1 ? matches[0]!.id : UNASSIGNED_PROJECT_ID
}

export function sessionsForProject(
  sessions: ReadonlyArray<Session>,
  projects: ReadonlyArray<Project>,
  projectId: string
): ReadonlyArray<Session> {
  return sessions.filter((session) => projectIdForSession(session, projects) === projectId)
}

export function preferredSessionId(
  sessions: ReadonlyArray<Session>,
  rememberedId?: string | null
): string | null {
  const available = sessions.filter((session) => !session.archived)
  if (rememberedId && available.some((session) => session.id === rememberedId)) return rememberedId
  return [...available].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null
}
