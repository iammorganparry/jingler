import { useCallback, useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { issueReferencesOf } from "@jingler/core"
import type { IssueListItem, Project, Repo, Session } from "@jingler/core"
import { rpc } from "./rpc-client.js"

/** Does this session link the GitHub issue? Reads canonical and legacy links alike. */
const linksIssue = (session: Session, issue: IssueListItem) => {
  const issueUrls = `https://github.com/${issue.repository}/issues/`.toLowerCase()
  return issueReferencesOf(session).some((reference) =>
    reference.providerId === "github" && reference.id === String(issue.number) &&
    (!reference.url || reference.url.toLowerCase().startsWith(issueUrls)))
}

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
        linksIssue(candidate, issue) && (candidate.repoPath === repo.path || candidate.projectId === project?.id)) ?? null
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

/** An issue picked while reading as `viewerLogin`; the pick is void under any other identity. */
export interface IssueSelection { readonly issue: IssueListItem; readonly viewerLogin: string }

/** The selection only counts while the list is still read by the account that made it. */
export const selectedIssueFor = (selection: IssueSelection | null, viewerLogin: string | null): IssueListItem | null =>
  selection !== null && viewerLogin !== null && selection.viewerLogin === viewerLogin ? selection.issue : null

const message = (error: unknown) => (error as { message?: string } | null)?.message ?? null

export function useIssueInbox() {
  const [selection, setSelection] = useState<IssueSelection | null>(null)
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ["github", "issue-inbox", "list"], queryFn: rpc.githubIssueInbox })
  const viewerLogin = list.data?.viewerLogin ?? null
  const selected = selectedIssueFor(selection, viewerLogin)
  const detail = useQuery({
    queryKey: ["github", "issue-inbox", "detail", viewerLogin, selected?.repository, selected?.number],
    queryFn: () => rpc.githubIssueBySlug(selected!.repository, selected!.number),
    enabled: selected !== null,
  })
  const refresh = useCallback(
    (cancelRefetch = true) => queryClient.invalidateQueries({ queryKey: ["github", "issue-inbox"] }, { cancelRefetch }),
    [queryClient]
  )
  const commentMutation = useMutation({
    mutationFn: (body: string) => selected
      ? rpc.githubIssueCommentBySlug(selected.repository, selected.number, body)
      : Promise.reject(new Error("Select an issue first.")),
    onSuccess: () => refresh(),
  })
  const closeMutation = useMutation({
    mutationFn: () => selected
      ? rpc.githubIssueCloseBySlug(selected.repository, selected.number)
      : Promise.reject(new Error("Select an issue first.")),
    onSuccess: () => refresh(),
  })
  const { reset: resetComment } = commentMutation
  const { reset: resetClose } = closeMutation
  // A different account must not inherit the previous one's private detail or errors.
  useEffect(() => {
    resetComment()
    resetClose()
    queryClient.removeQueries({ queryKey: ["github", "issue-inbox", "detail"] })
  }, [viewerLogin, queryClient, resetComment, resetClose])
  return {
    issues: list.data?.issues ?? [],
    viewerLogin,
    warnings: list.data?.warnings ?? [],
    loading: list.isPending,
    refreshing: list.isFetching,
    error: message(list.error),
    activate: useCallback(() => { void refresh(false) }, [refresh]),
    refresh: () => { void refresh() },
    selected,
    select: (issue: IssueListItem) => {
      if (viewerLogin === null) return
      commentMutation.reset(); closeMutation.reset(); setSelection({ issue, viewerLogin })
    },
    detail: detail.data ?? null,
    detailLoading: detail.isPending && selected !== null,
    detailError: message(detail.error),
    comment: (body: string) => commentMutation.mutateAsync(body),
    close: () => closeMutation.mutateAsync(),
    closeError: message(closeMutation.error),
  }
}
