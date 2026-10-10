import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { IssueListItem, Project, Repo, Session } from "@jingler/core"
import { rpc } from "./rpc-client.js"

/** The local project (if any) that can start a session for this issue's repository. */
export function issueSessionTarget(
  issue: IssueListItem | null,
  repos: ReadonlyArray<Repo>,
  projects: ReadonlyArray<Project>,
  sessions: ReadonlyArray<Session>
): { readonly project: Project | null; readonly session: Session | null } | null {
  if (issue === null) return null
  const repo = repos.find((candidate) => candidate.githubSlug === issue.repository)
  const project = repo
    ? projects.find((candidate) => candidate.path === repo.path && candidate.availability === "available") ?? null
    : null
  const session = repo
    ? sessions.find((candidate) =>
        candidate.issueNumber === issue.number && (candidate.repoPath === repo.path || candidate.projectId === project?.id)) ?? null
    : null
  return { project, session }
}

/** Open the existing session for the issue, else the new-session dialog seeded with it. */
export const issueSessionOpener = (
  issue: IssueListItem | null,
  target: ReturnType<typeof issueSessionTarget>,
  openSession: (sessionId: string) => void,
  startSession: (projectId: string, issue: IssueListItem) => void
) => () => {
  if (issue === null || target === null) return
  if (target.session) openSession(target.session.id)
  else if (target.project) startSession(target.project.id, issue)
}

export const issueSessionAction = (target: ReturnType<typeof issueSessionTarget>, onSelect: () => void) =>
  target === null ? undefined : {
    label: target.session ? "Open session" : "Start session",
    onSelect,
    ...(target.session || target.project
      ? {}
      : { disabledReason: "Add this repository as a local project to create a session." }),
  }

const message = (error: unknown) => (error as { message?: string } | null)?.message ?? null

export function useIssueInbox() {
  const [selected, setSelected] = useState<IssueListItem | null>(null)
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ["github", "issue-inbox", "list"], queryFn: rpc.githubIssueInbox })
  const detail = useQuery({
    queryKey: ["github", "issue-inbox", "detail", selected?.repository, selected?.number],
    queryFn: () => rpc.githubIssueBySlug(selected!.repository, selected!.number),
    enabled: selected !== null,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["github", "issue-inbox"] })
  const commentMutation = useMutation({
    mutationFn: (body: string) => selected
      ? rpc.githubIssueCommentBySlug(selected.repository, selected.number, body)
      : Promise.reject(new Error("Select an issue first.")),
    onSuccess: refresh,
  })
  const closeMutation = useMutation({
    mutationFn: () => selected
      ? rpc.githubIssueCloseBySlug(selected.repository, selected.number)
      : Promise.reject(new Error("Select an issue first.")),
    onSuccess: refresh,
  })
  return {
    issues: list.data ?? [],
    loading: list.isPending,
    error: message(list.error),
    selected,
    select: (issue: IssueListItem) => { commentMutation.reset(); closeMutation.reset(); setSelected(issue) },
    detail: detail.data ?? null,
    detailLoading: detail.isPending && selected !== null,
    detailError: message(detail.error),
    comment: (body: string) => commentMutation.mutateAsync(body),
    close: () => closeMutation.mutateAsync(),
    closeError: message(closeMutation.error),
  }
}
