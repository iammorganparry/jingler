import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  PrMergeMethod,
  Project,
  PullRequestListItem,
  Repo,
  Session
} from "@jingler/core"
import { rpc } from "./rpc-client.js"

export function pullRequestSessionTarget(
  pr: PullRequestListItem,
  repos: ReadonlyArray<Repo>,
  projects: ReadonlyArray<Project>,
  sessions: ReadonlyArray<Session>
): { readonly project: Project | null; readonly session: Session | null } {
  const repo = repos.find((candidate) => candidate.githubSlug === pr.repository)
  if (!repo) return { project: null, session: null }
  const project = projects.find(
    (candidate) => candidate.path === repo.path && candidate.availability === "available"
  ) ?? null
  return {
    project,
    session: sessions.find(
      (candidate) =>
        candidate.prNumber === pr.number &&
        (candidate.repoPath === repo.path || candidate.projectId === project?.id)
    ) ?? null
  }
}

export function usePullRequestInbox(connected: boolean) {
  const [selected, setSelected] = useState<PullRequestListItem | null>(null)
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["github", "pr-inbox"],
    queryFn: rpc.githubPrInbox,
    enabled: connected
  })
  const detail = useQuery({
    queryKey: ["github", "pr-inbox", selected?.repository, selected?.number],
    queryFn: () => selected ? rpc.githubPrBySlug(selected.repository, selected.number) : null,
    enabled: connected && selected !== null
  })
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["github", "pr-inbox"] })
  const commentMutation = useMutation({
    mutationFn: (body: string) => selected
      ? rpc.githubCommentBySlug(selected.repository, selected.number, body)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh
  })
  const closeMutation = useMutation({
    mutationFn: () => selected
      ? rpc.githubCloseBySlug(selected.repository, selected.number)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh
  })
  const mergeMutation = useMutation({
    mutationFn: (method: PrMergeMethod) => selected
      ? rpc.githubMergeBySlug(selected.repository, selected.number, method)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh
  })
  const resetActionErrors = () => {
    commentMutation.reset()
    closeMutation.reset()
    mergeMutation.reset()
  }

  return {
    prs: list.data ?? [],
    selected,
    select: setSelected,
    detail: detail.data ?? null,
    loading: connected && list.isPending,
    detailLoading: detail.isPending && selected !== null,
    detailError: (detail.error as { message?: string } | null)?.message ?? null,
    comment: (body: string) => {
      resetActionErrors()
      return commentMutation.mutateAsync(body)
    },
    close: () => {
      resetActionErrors()
      return closeMutation.mutateAsync()
    },
    merge: (method: PrMergeMethod) => {
      resetActionErrors()
      return mergeMutation.mutateAsync(method)
    },
    closing: closeMutation.isPending,
    closeError: (closeMutation.error as { message?: string } | null)?.message ?? null,
    merging: mergeMutation.isPending,
    mergeError: (mergeMutation.error as { message?: string } | null)?.message ?? null,
    error: connected
      ? (list.error as { message?: string } | null)?.message ?? null
      : "Connect GitHub to load pull requests."
  }
}
