import { activeCheckoutOf, checkoutsOf, type Project, type Session } from "@jingler/core"

export const UNASSIGNED_PROJECT_ID = "__unassigned__"
/** Sessions with 2+ checkouts live here, so switching checkouts never moves them between projects. */
export const MULTI_REPO_PROJECT_ID = "__multi_repo__"

export function projectIdForSession(
  session: Session,
  projects: ReadonlyArray<Project>
): string {
  if (checkoutsOf(session).length > 1) return MULTI_REPO_PROJECT_ID
  const checkout = activeCheckoutOf(session)
  if (checkout.projectId && projects.some((project) => project.id === checkout.projectId)) {
    return checkout.projectId
  }

  const matches = projects.filter(
    (project) =>
      project.environmentId === session.environmentId &&
      (project.path === checkout.repoPath || (!checkout.repoPath && project.name === checkout.repo))
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
