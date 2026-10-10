import { useMemo, useState } from "react"
import { useMachine } from "@xstate/react"
import type { IssueDetail, IssueListItem } from "@jingler/core"
import { ArrowLeft, CircleDot, MessageSquare } from "lucide-react"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { AsyncButton } from "../components/async-button.js"
import { Badge } from "../components/badge.js"
import { Callout } from "../components/callout.js"
import { Card } from "../components/card.js"
import { Markdown } from "../components/markdown.js"
import { Spinner } from "../components/loading.js"
import { SearchInput } from "../components/search-input.js"
import { MotionTabs } from "../components/beui/controls.js"
import { atLeast, useWidthTier, WidthTierProvider } from "../hooks/width-tier.js"
import { cn } from "../lib/cn.js"
import { relativeTime } from "../lib/relative-time.js"
import { IssueLabelChip } from "./issue-picker-list.js"
import { InboxFilterSelect, InboxMessage, filterOptions } from "./pull-request-inbox.js"
import {
  initialIssueInboxFilters, issueInboxFilterMachine, type IssueInboxFacets, type IssueInboxFilter
} from "./issue-inbox-filter-machine.js"

export type { IssueInboxFacets, IssueInboxFilter } from "./issue-inbox-filter-machine.js"

const FILTERS: ReadonlyArray<{ value: IssueInboxFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "created", label: "Created" },
  { value: "assigned", label: "Assigned" }
]

const keyOf = (issue: Pick<IssueListItem, "repository" | "number">) => `${issue.repository}#${issue.number}`
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()
const matchesChoice = (actual: string, selected: string) => !selected || same(actual, selected)

const hasAssignee = (issue: IssueListItem, login: string) => issue.assignees.some((assignee) => same(assignee.name, login))

const matchesRelationship = (issue: IssueListItem, filter: IssueInboxFilter, viewerLogin: string) =>
  filter === "created" ? same(issue.author?.name, viewerLogin)
    : filter === "assigned" ? hasAssignee(issue, viewerLogin)
    : true

const matchesFacets = (issue: IssueListItem, facets: IssueInboxFacets) =>
  matchesChoice(issue.repository, facets.repository) &&
  matchesChoice(issue.author?.name ?? "", facets.author) &&
  (!facets.assignee || hasAssignee(issue, facets.assignee)) &&
  (!facets.label || issue.labels.some((label) => same(label.name, facets.label)))

export function filterIssues(
  issues: ReadonlyArray<IssueListItem>,
  filter: IssueInboxFilter,
  query: string,
  viewerLogin: string,
  facets: IssueInboxFacets = initialIssueInboxFilters
): ReadonlyArray<IssueListItem> {
  const search = query.trim().toLowerCase()
  return issues.filter((issue) =>
    matchesRelationship(issue, filter, viewerLogin) && matchesFacets(issue, facets) &&
    (search.length === 0 ||
      `${issue.title} ${issue.repository} ${issue.author?.name ?? ""} ${issue.number}`.toLowerCase().includes(search)))
}

export interface IssueInboxProps {
  issues: ReadonlyArray<IssueListItem>
  viewerLogin: string
  selected: { repository: string; number: number } | null
  detail: IssueDetail | null
  onSelect: (issue: IssueListItem) => void
  onOpenOnGithub?: (url: string) => void
  onComment?: (body: string) => Promise<void> | void
  onCloseIssue?: () => Promise<void> | void
  closeError?: string | null
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

/** Global GitHub issue list with a responsive detail pane, modelled on PullRequestInbox. */
export function IssueInbox({
  issues, viewerLogin, selected, detail, onSelect, onOpenOnGithub, onComment, onCloseIssue, closeError,
  sessionAction, loading = false, detailLoading = false, detailError = null, error = null
}: IssueInboxProps) {
  const [filterState, sendFilters] = useMachine(issueInboxFilterMachine)
  const facets = filterState.context
  const { filter, query } = facets
  const options = useMemo(() => ({
    repository: filterOptions(issues.map((issue) => issue.repository)),
    author: filterOptions(issues.flatMap((issue) => issue.author ? [issue.author.name] : [])),
    assignee: filterOptions(issues.flatMap((issue) => issue.assignees.map((assignee) => assignee.name))),
    label: filterOptions(issues.flatMap((issue) => issue.labels.map((label) => label.name))),
  }), [issues])
  const [mobileDetail, setMobileDetail] = useState(false)
  const compact = !atLeast(useWidthTier(), "mid")
  const visible = useMemo(
    () => filterIssues(issues, filter, query, viewerLogin, facets),
    [issues, filter, query, viewerLogin, facets]
  )
  const selectedKey = selected ? keyOf(selected) : null
  const showList = !(compact && mobileDetail && selected !== null)
  const filtered = Boolean(query || filter !== "all" || facets.repository || facets.author || facets.assignee || facets.label)
  const change = (fields: Partial<typeof facets>) => sendFilters({ type: "CHANGE", fields })

  function renderList() {
    if (loading) return <InboxMessage><Spinner size={18} />Loading issues…</InboxMessage>
    if (error) return <InboxMessage>{error}</InboxMessage>
    if (visible.length === 0) return <InboxMessage><CircleDot className="size-5 text-dim" />No issues match this view.</InboxMessage>
    return visible.map((issue) => (
      <button
        key={keyOf(issue)}
        type="button"
        aria-pressed={keyOf(issue) === selectedKey}
        onClick={() => {
          onSelect(issue)
          if (compact) setMobileDetail(true)
        }}
        className={cn(
          "flex w-full flex-col gap-2 border-b border-hairline px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          keyOf(issue) === selectedKey ? "bg-selection" : "hover:bg-surface"
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          <CircleDot className="mt-0.5 size-4 flex-none text-green" />
          <span className="min-w-0 flex-1 text-[13px] font-semibold leading-[1.35] text-text-bright">{issue.title}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 pl-6 font-mono text-[10.5px] text-muted-foreground">
          <span className="truncate">{issue.repository}</span>
          <span className="text-line">#{issue.number}</span>
          <span className="flex-1" />
          <span>{relativeTime(issue.updatedAt)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6">
          {issue.author && <>
            <Avatar initial={(issue.author.name[0] ?? "?").toUpperCase()} src={issue.author.avatarUrl ?? githubAvatarUrl(issue.author.name, 32)} size={17} />
            <span className="text-[10.5px] text-muted-foreground">{issue.author.name}</span>
          </>}
          {issue.labels.slice(0, 2).map((label) => <IssueLabelChip key={label.name} {...label} />)}
          <span className="flex-1" />
          {issue.comments > 0 && <span className="flex items-center gap-1 font-mono text-[10px] text-dim"><MessageSquare className="size-3" />{issue.comments}</span>}
        </div>
      </button>
    ))
  }

  function renderDetail() {
    if (selected === null) return <InboxMessage><CircleDot className="size-6 text-dim" />Select an issue to read it.</InboxMessage>
    if (detailError && detail === null) return <InboxMessage>{detailError}</InboxMessage>
    if (detail === null) return <InboxMessage><Spinner size={18} />Loading issue…</InboxMessage>
    return (
      <IssueDetailPane
        key={selectedKey ?? "none"}
        issue={detail}
        repository={selected.repository}
        busy={detailLoading}
        error={detailError}
        closeError={closeError}
        sessionAction={sessionAction}
        onOpenOnGithub={onOpenOnGithub}
        onComment={onComment}
        onCloseIssue={onCloseIssue}
      />
    )
  }

  return (
    <div data-testid="issue-inbox" className="flex min-h-0 min-w-0 flex-1 bg-editor">
      {showList && (
        <section className={cn("flex min-h-0 min-w-0 flex-col border-r border-line bg-panel", compact ? "flex-1" : "w-1/3 min-w-[280px] max-w-[430px]")}>
          <header className="flex flex-none flex-col gap-3 border-b border-line px-4 py-3.5">
            <div className="flex items-center gap-2">
              <CircleDot className="size-4 text-green" />
              <h1 className="text-[14px] font-semibold text-text-bright">Issues</h1>
              <Badge tone="count" size="xs">{visible.length}</Badge>
            </div>
            <SearchInput value={query} onChange={(next) => change({ query: next })} placeholder="Search issues" />
            <MotionTabs items={FILTERS} value={filter} onChange={(next) => change({ filter: next })} variant="segment" />
            <div className="grid min-w-0 grid-cols-2 gap-2">
              {(["repository", "author", "assignee", "label"] as const).map((kind) => <InboxFilterSelect
                key={kind} label={kind[0]!.toUpperCase() + kind.slice(1)}
                value={facets[kind]} options={[{ value: "", label: "All" }, ...options[kind]]}
                onChange={(value) => change({ [kind]: value })}
              />)}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{visible.length} of {issues.length} loaded issues</span>
              {filtered && <button type="button" className="shrink-0 text-brand hover:underline" onClick={() => sendFilters({ type: "CLEAR" })}>Clear filters</button>}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{renderList()}</div>
        </section>
      )}
      {(!compact || mobileDetail) && (
        <WidthTierProvider className="flex-col bg-editor">
          {compact && (
            <button type="button" onClick={() => setMobileDetail(false)} className="mx-6 mt-4 flex h-8 w-fit flex-none items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[11px] text-muted-foreground hover:text-text">
              <ArrowLeft className="size-3.5" /> Back
            </button>
          )}
          {renderDetail()}
        </WidthTierProvider>
      )}
    </div>
  )
}

function IssueDetailPane({ issue, repository, busy, error, closeError, sessionAction, onOpenOnGithub, onComment, onCloseIssue }: {
  issue: IssueDetail
  repository: string
  busy: boolean
  error: string | null
  closeError?: string | null
  sessionAction?: IssueInboxProps["sessionAction"]
  onOpenOnGithub?: (url: string) => void
  onComment?: (body: string) => Promise<void> | void
  onCloseIssue?: () => Promise<void> | void
}) {
  const [body, setBody] = useState("")
  const [commentError, setCommentError] = useState<string | null>(null)
  const submit = async () => {
    setCommentError(null)
    try {
      await onComment?.(body.trim())
      setBody("")
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : "Failed to post comment.")
      throw e
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5" aria-busy={busy}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={issue.state === "open" ? "green" : "purple"} size="xs">{issue.state === "open" ? "Open" : "Closed"}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">{repository} {issue.identifier}</span>
          <div className="flex-1" />
          {issue.url && onOpenOnGithub && (
            <button type="button" onClick={() => onOpenOnGithub(issue.url)} className="font-mono text-[11px] text-dim hover:text-text">
              Open on GitHub ↗
            </button>
          )}
        </div>
        <h2 className="text-balance text-[17px] font-semibold text-text-bright">{issue.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => <IssueLabelChip key={label.name} {...label} />)}
        </div>
        <div className="grid grid-flow-col auto-cols-fr gap-2 self-end">
          {sessionAction && (
            <span title={sessionAction.disabledReason} className="flex">
              <AsyncButton variant="primary" className="w-full" disabled={sessionAction.disabledReason !== undefined} onClick={sessionAction.onSelect}>
                {sessionAction.label}
              </AsyncButton>
            </span>
          )}
          {onCloseIssue && issue.state === "open" && (
            <AsyncButton variant="danger" className="w-full" pendingLabel="Closing…" successLabel="Closed" onClick={onCloseIssue}>Close issue</AsyncButton>
          )}
        </div>
        {sessionAction?.disabledReason && <p className="self-end text-xs text-muted-foreground">{sessionAction.disabledReason}</p>}
        {closeError && <Callout tone="red">{closeError}</Callout>}
        {error && <p role="alert" className="text-xs text-red">{error}</p>}
      </div>
      {issue.body.trim() && (
        <Card className="flex-none">
          <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-[11px]">
            {issue.author && <Avatar initial={issue.author.name.charAt(0).toUpperCase()} src={issue.author.avatarUrl ?? githubAvatarUrl(issue.author.name)} size={22} />}
            <span className="text-[13px] font-semibold text-text-bright">{issue.author?.name ?? "unknown"}</span>
            <span className="text-[11.5px] text-muted-foreground">opened this</span>
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-dim">{relativeTime(issue.createdAt)}</span>
          </div>
          <div className="px-[14px] py-[11px]"><Markdown className="text-[13.5px]" repository={repository}>{issue.body}</Markdown></div>
        </Card>
      )}
      {issue.comments.map((comment) => (
        <Card key={comment.id} className="flex-none">
          <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-[11px]">
            {comment.author && <Avatar initial={comment.author.name.charAt(0).toUpperCase()} src={comment.author.avatarUrl ?? githubAvatarUrl(comment.author.name)} size={22} />}
            <span className="text-[13px] font-semibold text-text-bright">{comment.author?.name ?? "unknown"}</span>
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-dim">{relativeTime(comment.createdAt)}</span>
          </div>
          <div className="px-[14px] py-[11px]"><Markdown className="text-[13.5px]" repository={repository}>{comment.body}</Markdown></div>
        </Card>
      ))}
      {onComment && (
        <div className="sticky bottom-0 mt-auto overflow-hidden rounded-xl border border-line bg-panel">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Leave a comment…"
            aria-label="Issue comment"
            rows={2}
            className="w-full resize-none bg-transparent px-[14px] py-[11px] text-[13.5px] text-text-body outline-none placeholder:text-dim"
          />
          {commentError && <div className="px-[14px] pb-[11px]"><Callout tone="red">{commentError}</Callout></div>}
          <div className="flex items-center justify-end border-t border-hairline px-[14px] py-[11px]">
            <AsyncButton variant="secondary" disabled={body.trim().length === 0} pendingLabel="Posting…" successLabel="Commented" onClick={submit}>
              Comment
            </AsyncButton>
          </div>
        </div>
      )}
    </div>
  )
}
