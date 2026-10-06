import { type ReactNode, useEffect, useMemo, useState } from "react"
import type { GitHubTeam, GitHubTeamQueue, PrMergeMethod, PullRequest, PullRequestListItem } from "@jingler/core"
import { ArrowLeft, GitPullRequest, MessageSquare } from "lucide-react"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { Spinner } from "../components/loading.js"
import { SearchInput } from "../components/search-input.js"
import { MotionTabs } from "../components/beui/controls.js"
import { atLeast, useWidthTier, WidthTierProvider } from "../hooks/width-tier.js"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { IssueLabelChip } from "./issue-picker-list.js"
import { PullRequestView } from "./pull-request-view.js"

export type PullRequestInboxFilter = "all" | "created" | "assigned" | "review-requested"

const FILTERS: ReadonlyArray<{ value: PullRequestInboxFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "created", label: "Created" },
  { value: "assigned", label: "Assigned" },
  { value: "review-requested", label: "Review requested" }
]

const keyOf = (pr: Pick<PullRequestListItem, "repository" | "number">) =>
  `${pr.repository}#${pr.number}`

export function filterPullRequests(
  prs: ReadonlyArray<PullRequestListItem>,
  filter: PullRequestInboxFilter,
  query: string,
  viewerLogin: string
): ReadonlyArray<PullRequestListItem> {
  const search = query.trim().toLowerCase()
  return prs.filter((pr) => {
    if (filter === "created" && pr.author.login.toLowerCase() !== viewerLogin.toLowerCase()) return false
    if (filter === "assigned" && !pr.assignedToViewer) return false
    if (filter === "review-requested" && !pr.reviewRequestedFromViewer) return false
    return search.length === 0 || `${pr.title} ${pr.repository} ${pr.author.login} ${pr.number}`.toLowerCase().includes(search)
  })
}

export interface PullRequestInboxProps {
  prs: ReadonlyArray<PullRequestListItem>
  teamControls?: {
    readonly teams: ReadonlyArray<GitHubTeam>
    readonly teamId: string | null
    readonly queue: GitHubTeamQueue
    readonly onTeam: (id: string | null) => void
    readonly onQueue: (queue: GitHubTeamQueue) => void
    readonly onRefresh: () => void
    readonly discovering: boolean
    readonly error: string | null
  }
  onActivate?: () => void
  warnings?: ReadonlyArray<string>
  viewerLogin: string
  selected: { repository: string; number: number } | null
  detail: PullRequest | null
  onSelect: (pr: PullRequestListItem) => void
  onOpenOnGithub?: (url: string) => void
  onOpenFiles?: () => void
  onComment?: (body: string) => Promise<void> | void
  onClosePr?: () => Promise<void> | void
  onMerge?: (method: PrMergeMethod) => Promise<void> | void
  closing?: boolean
  closeError?: string | null
  merging?: boolean
  mergeError?: string | null
  sessionAction?: {
    readonly label: string
    readonly onSelect: () => void
    readonly disabledReason?: string
  }
  loading?: boolean
  detailLoading?: boolean
  detailError?: string | null
  error?: string | null
}

/** Global GitHub-style PR list with a responsive read-only detail pane. */
export function PullRequestInbox({
  prs,
  teamControls,
  onActivate,
  warnings = [],
  viewerLogin,
  selected,
  detail,
  onSelect,
  onOpenOnGithub,
  onOpenFiles,
  onComment,
  onClosePr,
  onMerge,
  closing,
  closeError,
  merging,
  mergeError,
  sessionAction,
  loading = false,
  detailLoading = false,
  detailError = null,
  error = null
}: PullRequestInboxProps) {
         function renderSelectedPullRequest() {
           return (<PullRequestView
              key={selectedKey ?? "none"}
              pr={detail}
              connected
              busy={detailLoading}
              viewerLogin={viewerLogin}
              readOnly
              onOpenSession={sessionAction?.onSelect}
              sessionActionLabel={sessionAction?.label}
              sessionActionDisabledReason={sessionAction?.disabledReason}
              onOpenOnGithub={detail?.url && onOpenOnGithub ? () => onOpenOnGithub(detail.url) : undefined}
              onOpenFiles={onOpenFiles}
              onComment={onComment}
              onClosePr={onClosePr}
              onMerge={onMerge}
              closing={closing}
              closeError={closeError}
              merging={merging}
              mergeError={mergeError}
            />)
         }

         function getLoading() {
           if (loading) return (<InboxMessage><Spinner size={18} />Loading pull requests…</InboxMessage>)
           if (error) return (<InboxMessage>{error}</InboxMessage>)
           if (visible.length === 0) return (<InboxMessage><GitPullRequest className="size-5 text-dim" />{warnings.length > 0 ? "No pull requests loaded. Some results could not be retrieved." : "No pull requests match this view."}</InboxMessage>)
           return (visible.map((pr) => {
              const active = keyOf(pr) === selectedKey
              return (
                <button
                  key={keyOf(pr)}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onSelect(pr)
                    if (compact) setMobileDetail(true)
                  }}
                  className={cn(
                    "flex w-full flex-col gap-2 border-b border-hairline px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-selection" : "hover:bg-surface"
                  )}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <GitPullRequest className={cn("mt-0.5 size-4 flex-none", pr.isDraft ? "text-dim" : "text-green")} />
                    <span className="min-w-0 flex-1 text-[13px] font-semibold leading-[1.35] text-text-bright">{pr.title}</span>
                    {pr.isDraft && <Badge tone="neutral" size="xs">Draft</Badge>}
                  </div>
                  <div className="flex min-w-0 items-center gap-2 pl-6 font-mono text-[10.5px] text-muted-foreground">
                    <span className="truncate">{pr.repository}</span>
                    <span className="text-line">#{pr.number}</span>
                    <span className="flex-1" />
                    <span>{relativeTime(pr.updatedAt)}</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6">
                    <Avatar initial={(pr.author.login[0] ?? "?").toUpperCase()} src={pr.author.avatarUrl ?? githubAvatarUrl(pr.author.login, 32)} size={17} />
                    <span className="text-[10.5px] text-muted-foreground">{pr.author.login}</span>
                    {pr.labels.slice(0, 2).map((label) => <IssueLabelChip key={label.name} {...label} />)}
                    <span className="flex-1" />
                    <DiffStat added={pr.additions} removed={pr.deletions} />
                    {pr.comments > 0 && <span className="flex items-center gap-1 font-mono text-[10px] text-dim"><MessageSquare className="size-3" />{pr.comments}</span>}
                  </div>
                </button>
              )
            }))
         }

  const [filter, setFilter] = useState<PullRequestInboxFilter>("all")
  const [query, setQuery] = useState("")
  const [mobileDetail, setMobileDetail] = useState(false)
  const compact = !atLeast(useWidthTier(), "mid")
  const isTeam = Boolean(teamControls?.teamId)
  const visible = useMemo(
    () => filterPullRequests(prs, isTeam ? "all" : filter, query, viewerLogin),
    [filter, prs, query, viewerLogin, isTeam]
  )
  useEffect(() => {
    onActivate?.()
    const onVisible = () => { if (document.visibilityState === "visible") onActivate?.() }
    const onFocus = () => onActivate?.()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [onActivate])
  const selectedKey = selected ? `${selected.repository}#${selected.number}` : null
  const showList = !(compact && mobileDetail && selected !== null)

  return (
    <div data-testid="pull-request-inbox" className="flex min-h-0 min-w-0 flex-1 bg-editor">
      {showList && (
        <section className={cn("flex min-h-0 flex-col border-r border-line bg-panel", compact ? "flex-1" : "w-1/3 min-w-[280px] max-w-[430px]")}>
          <header className="flex flex-none flex-col gap-3 border-b border-line px-4 py-3.5">
            <div className="flex items-center gap-2">
              <GitPullRequest className="size-4 text-green" />
              <h1 className="text-[14px] font-semibold text-text-bright">Pull requests</h1>
              <Badge tone="count" size="xs">{visible.length}</Badge>
            </div>
            <SearchInput value={query} onChange={setQuery} placeholder="Search pull requests" />
            {teamControls ? <InboxTeamControls controls={teamControls} filter={filter} onFilter={setFilter} />
              : <MotionTabs items={FILTERS} value={filter} onChange={setFilter} variant="segment" />}
            {warnings.length > 0 && <div role="status" className="text-xs text-yellow">
              <strong>Partial results</strong>
              {warnings.map((warning) => <p key={warning}>{warning}</p>)}
              <p>Use Refresh to retry missing results.</p>
            </div>}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {getLoading()}
          </div>
        </section>
      )}

      {(!compact || mobileDetail) && (
        <WidthTierProvider className="relative bg-editor">
          {compact && (
            <button type="button" onClick={() => setMobileDetail(false)} className="absolute left-3 top-3 z-20 flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[11px] text-muted-foreground shadow-sm hover:text-text">
              <ArrowLeft className="size-3.5" /> Back
            </button>
          )}
          {selected === null ? (
            <InboxMessage><GitPullRequest className="size-6 text-dim" />Select a pull request to review it.</InboxMessage>
          ) : detailError ? (
            <InboxMessage>{detailError}</InboxMessage>
          ) : (
            renderSelectedPullRequest()
          )}
        </WidthTierProvider>
      )}
    </div>
  )
}

function InboxTeamControls({ controls: teamControls, filter, onFilter: setFilter }: {
  controls: NonNullable<PullRequestInboxProps["teamControls"]>
  filter: PullRequestInboxFilter
  onFilter: (filter: PullRequestInboxFilter) => void
}) {
  return <>
            <>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Pull request scope"
                  value={teamControls.teamId ?? ""}
                  onChange={(event) => teamControls.onTeam(event.target.value || null)}
                  disabled={teamControls.discovering}
                  className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5 text-xs text-text focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Personal</option>
                  {[...new Set(teamControls.teams.map((team) => team.organization))].map((organization) =>
                    <optgroup key={organization} label={organization}>
                      {teamControls.teams.filter((team) => team.organization === organization).map((team) =>
                        <option key={team.id} value={team.id}>{team.name}</option>)}
                    </optgroup>)}
                </select>
                <button type="button" onClick={teamControls.onRefresh} disabled={teamControls.discovering} className="rounded border border-line px-2 py-1.5 text-xs text-text hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring">
                  {teamControls.discovering ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {teamControls.error && <p role="alert" className="text-xs text-red">{teamControls.error}</p>}
              {!teamControls.discovering && !teamControls.error && teamControls.teams.length === 0 && <p className="text-xs text-muted-foreground">No organization teams are visible to your GitHub CLI account.</p>}
            </>
            {teamControls.teamId !== null ? <select
              aria-label="Team pull request queue"
              value={teamControls.queue}
              onChange={(event) => teamControls.onQueue(event.target.value as GitHubTeamQueue)}
              disabled={teamControls.discovering}
              className="rounded border border-line bg-surface px-2 py-1.5 text-xs text-text focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="reviews">Requested reviews</option>
              <option value="authored">Member-authored</option>
              <option value="repositories">Team repositories</option>
            </select> : <MotionTabs items={FILTERS} value={filter} onChange={setFilter} variant="segment" />}
  </>
}

function InboxMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-muted-foreground">{children}</div>
}
