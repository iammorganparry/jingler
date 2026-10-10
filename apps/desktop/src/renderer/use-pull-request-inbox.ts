import { useCallback, useRef } from "react"
import { useMachine } from "@xstate/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  PrMergeMethod,
  Project,
  PullRequestListItem,
  PullRequest,
  Repo,
  Session,
  GitHubTeamQueue
} from "@jingler/core"
import { rpc } from "./rpc-client.js"
import { pullRequestInboxMachine } from "./pull-request-inbox-machine.js"

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

const inboxQueryIdentity = (
  account: { id: string; login: string } | null,
  team: { organization: string; slug: string } | undefined,
  selected: PullRequestListItem | null
) => ({
  accountId: account?.id, viewerLogin: account?.login,
  organization: team?.organization, teamSlug: team?.slug,
  repository: selected?.repository, number: selected?.number,
})

export const pullRequestInboxViewerLogin = (teamMode: boolean, ready: boolean, login: string | undefined) =>
  teamMode && ready ? login : undefined

const teamPrTarget = (selected: PullRequestListItem | null, account: { id: string } | null) =>
  selected && account ? { accountId: account.id, repository: selected.repository, number: selected.number } : null

const samePullRequest = (a: PullRequestListItem | null, b: PullRequestListItem | null) =>
  a?.repository === b?.repository && a?.number === b?.number

type PersonalIdentityPlaceholder = { accountId: string; selected: PullRequestListItem | null; data: PullRequest | null | undefined }

const preparePersonalIdentityPlaceholder = (
  current: PersonalIdentityPlaceholder | null, accountId: string | undefined,
  teamMode: boolean, selected: PullRequestListItem | null
): PersonalIdentityPlaceholder | null => {
  const placeholder = current ?? (accountId !== undefined ? { accountId, selected: teamMode ? null : selected, data: undefined } : null)
  // Only the selection mounted before first identity may bridge unknown/App data.
  if (placeholder && (teamMode || !samePullRequest(selected, placeholder.selected) || accountId !== placeholder.accountId)) {
    placeholder.selected = null
    placeholder.data = undefined
  }
  return placeholder
}

const personalDetailData = (placeholder: PersonalIdentityPlaceholder | null, data: PullRequest | null | undefined, isPlaceholder: boolean) => {
  // Query drops placeholderData on error; keep the display-only bridge until a verified read.
  if (placeholder && data !== undefined && !isPlaceholder) placeholder.data = undefined
  return data ?? placeholder?.data ?? null
}

export function usePullRequestInbox(_connected: boolean) {
  const [state, send] = useMachine(pullRequestInboxMachine, { input: { discover: rpc.githubTeams } })
  const { account, teams, teamId, queue, selected, revision, discoveryError } = state.context
  const team = teams.find((candidate) => candidate.id === teamId)
  const identity = inboxQueryIdentity(account, team, selected)
  const teamMode = teamId !== null
  const ready = state.matches("ready")
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["github", "pr-inbox", "personal", identity.accountId, revision],
    queryFn: rpc.githubPrInbox,
    enabled: !teamMode,
  })
  const teamList = useQuery({
    queryKey: ["github", "pr-inbox", "team", identity.accountId, identity.organization, identity.teamSlug, queue, revision],
    queryFn: () => account && team ? rpc.githubTeamPrs({
      accountId: account.id, organization: team.organization, teamSlug: team.slug,
      queue, refresh: state.context.refreshDiscovery,
    }) : Promise.reject(new Error("Refresh teams first.")),
    enabled: teamMode && ready && account !== null && team !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const personalIdentityPlaceholder = useRef<PersonalIdentityPlaceholder | null>(null)
  const placeholder = preparePersonalIdentityPlaceholder(personalIdentityPlaceholder.current, identity.accountId, teamMode, selected)
  personalIdentityPlaceholder.current = placeholder
  const detail = useQuery({
    queryKey: ["github", "pr-inbox", "detail", teamMode ? "team-cli" : "personal", identity.accountId, identity.repository, identity.number],
    queryFn: () => selected
      ? teamMode && account
        ? rpc.githubTeamPr({ accountId: account.id, repository: selected.repository, number: selected.number })
        : rpc.githubPrBySlug(selected.repository, selected.number)
      : null,
    // First CLI identity may arrive after a Personal/App detail read. Keep its mounted
    // composer while re-reading, without copying unverified data into the known cache.
    placeholderData: (previous, previousQuery) => {
      if (previous !== undefined && !teamMode && account !== null && selected !== null &&
          placeholder?.accountId === account.id && samePullRequest(placeholder.selected, selected) &&
          previousQuery?.queryKey[3] === "personal" && previousQuery.queryKey[4] === undefined &&
          previousQuery.queryKey[5] === selected.repository && previousQuery.queryKey[6] === selected.number) {
        placeholder.data = previous
        return previous
      }
      return undefined
    },
    enabled: selected !== null && (!teamMode || ready),
    retry: teamMode ? false : undefined,
  })
  const detailData = personalDetailData(placeholder, detail.data, detail.isPlaceholderData)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["github", "pr-inbox"] })
  // Focus/visibility share their read; an explicit refresh supersedes an older one.
  const discover = useCallback((cancelRefetch = false) => {
    void queryClient.invalidateQueries({ queryKey: ["github", "pr-inbox", "detail"] }, { cancelRefetch })
    send({ type: "DISCOVER" })
  }, [queryClient, send])
  const target = teamPrTarget(selected, ready ? account : null)
  const commentMutation = useMutation({
    mutationFn: (body: string) => selected
      ? teamMode
        ? target ? rpc.githubTeamComment({ ...target, body }) : Promise.reject(new Error("Refresh teams first."))
        : rpc.githubCommentBySlug(selected.repository, selected.number, body)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh,
  })
  const closeMutation = useMutation({
    mutationFn: () => selected
      ? teamMode
        ? target ? rpc.githubTeamClose(target) : Promise.reject(new Error("Refresh teams first."))
        : rpc.githubCloseBySlug(selected.repository, selected.number)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh,
  })
  const mergeMutation = useMutation({
    mutationFn: (method: PrMergeMethod) => selected
      ? teamMode
        ? target ? rpc.githubTeamMerge({ ...target, method }) : Promise.reject(new Error("Refresh teams first."))
        : rpc.githubMergeBySlug(selected.repository, selected.number, method)
      : Promise.reject(new Error("Select a pull request first.")),
    onSuccess: refresh,
  })
  const resetActionErrors = () => {
    commentMutation.reset()
    closeMutation.reset()
    mergeMutation.reset()
  }
  const message = (error: unknown) => (error as { message?: string } | null)?.message ?? null

  const teamData = ready ? teamList.data : undefined
  const currentList = teamMode ? teamList : list
  const rows = () => {
    if (teamMode) return teamData?.prs ?? []
    return list.data ?? []
  }
  const listLoading = () => {
    if (teamMode) return state.matches("discovering") || ready && teamList.isPending
    return list.isPending
  }

  return {
    prs: rows(),
    viewerLogin: pullRequestInboxViewerLogin(teamMode, ready, identity.viewerLogin),
    cliAccountId: teamMode ? identity.accountId : undefined,
    teams,
    teamId,
    queue,
    selectTeam: (id: string | null) => { resetActionErrors(); send({ type: "TEAM", teamId: id }) },
    selectQueue: (next: GitHubTeamQueue) => { resetActionErrors(); send({ type: "QUEUE", queue: next }) },
    discover,
    refreshInbox: () => discover(true),
    discovering: state.matches("discovering"),
    discoveryError,
    warnings: teamData?.warnings ?? [],
    selected,
    select: (pr: PullRequestListItem) => { resetActionErrors(); send({ type: "SELECT", pr }) },
    detail: detailData,
    loading: listLoading(),
    detailLoading: detail.isPending && selected !== null,
    detailError: message(detail.error),
    comment: (body: string) => { resetActionErrors(); return commentMutation.mutateAsync(body) },
    close: () => { resetActionErrors(); return closeMutation.mutateAsync() },
    merge: (method: PrMergeMethod) => { resetActionErrors(); return mergeMutation.mutateAsync(method) },
    closing: closeMutation.isPending,
    closeError: message(closeMutation.error),
    merging: mergeMutation.isPending,
    mergeError: message(mergeMutation.error),
    error: message(currentList.error) ?? (teamMode ? discoveryError : null),
  }
}
