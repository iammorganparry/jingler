import { useEffect, useState } from "react"
import type {
  PrLabel,
  PrMergeMethod,
  PrReviewThread,
  PrState,
  PrTimelineItem,
  PublishCheckpoint,
  PublishStep,
  PullRequest,
  ReviewSubmitKind
} from "@jingler/core"
import { Check, Download, GitCommit, GitPullRequest, PanelRight } from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Card } from "../components/card.js"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { Markdown } from "../components/markdown.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { DiffStat } from "../components/diff-stat.js"
import { StatusDot } from "../components/status-dot.js"
import { MotionTabs } from "../components/beui/controls.js"
import { PrCheckRow } from "./pr-check-row.js"
import { PrReviewComposer } from "./pr-review-composer.js"
import { PrReviewGroup } from "./pr-review-group.js"
import { PrSidePanel, type PrSidePanelProps } from "./pr-side-panel.js"
import { PrTimelineEntry } from "./pr-timeline-entry.js"

type PrEvidence = "overview" | "commits" | "checks" | "files"

/** Per-state colouring for the header status lozenge. */
const stateMeta: Record<PrState, { label: string; text: string; bg: string; border: string; dot: string }> = {
  open: { label: "Open", text: "text-green", bg: "bg-green/[0.13]", border: "border-green/30", dot: "bg-green" },
  merged: { label: "Merged", text: "text-purple", bg: "bg-purple/[0.13]", border: "border-purple/30", dot: "bg-purple" },
  closed: { label: "Closed", text: "text-red", bg: "bg-red/[0.08]", border: "border-red/30", dot: "bg-red" },
  draft: { label: "Draft", text: "text-dim", bg: "bg-hover", border: "border-line", dot: "bg-line-strong" }
}

/** The bordered status lozenge (green Open / purple Merged / red Closed / neutral Draft). */
function StatePill({ state }: { state: PrState }) {
  const m = stateMeta[state]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-[11px] py-1 text-[12px] font-semibold",
        m.text,
        m.bg,
        m.border
      )}
    >
      <StatusDot tone={m.dot} size={7} glow={false} />
      {m.label}
    </span>
  )
}

/** A single PR label chip, tinted with the label's own colour when known. */
function LabelChip({ label }: { label: PrLabel }) {
  if (!label.color) {
    return (
      <Badge tone="neutral" size="sm">
        {label.name}
      </Badge>
    )
  }
  const hex = `#${label.color.replace(/^#/, "")}`
  return (
    <span
      className="rounded-md px-[9px] py-0.5 text-[10.5px]"
      style={{ color: hex, backgroundColor: `${hex}22` }}
    >
      {label.name}
    </span>
  )
}

/**
 * One entry in the merged timeline: either a top-level review / issue comment,
 * or a group of inline threads opened by a single review.
 */
type FeedEntry =
  | { kind: "item"; at: string; item: PrTimelineItem }
  | { kind: "threads"; at: string; id: string; threads: ReadonlyArray<PrReviewThread> }

/**
 * Merge top-level timeline items and inline review threads into one
 * chronological feed, so a review's threads appear at the moment the review was
 * submitted rather than in a separate block.
 *
 * Threads are grouped by the review that opened them; a thread whose `reviewId`
 * is null (GitHub occasionally reports none) stands alone under its own header,
 * keyed by thread id so it can't collide with a real review group.
 */
const buildFeed = (pr: PullRequest): ReadonlyArray<FeedEntry> => {
  const groups = new Map<string, Array<PrReviewThread>>()
  for (const thread of pr.reviewThreads) {
    const key = thread.reviewId ?? `thread:${thread.id}`
    const existing = groups.get(key)
    if (existing) existing.push(thread)
    else groups.set(key, [thread])
  }

  const entries: Array<FeedEntry> = [
    ...pr.timeline.map((item) => ({ kind: "item" as const, at: item.createdAt, item })),
    ...[...groups].flatMap(([id, threads]) => {
      // The group sits at its earliest comment — when the review landed.
      const at = threads
        .flatMap((t) => t.comments.map((c) => c.createdAt))
        .reduce<string | null>((min, c) => (min === null || c < min ? c : min), null)
      return at === null ? [] : [{ kind: "threads" as const, at, id, threads }]
    })
  ]

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

const PUBLISH_PROGRESS: ReadonlyArray<{ readonly step: PublishStep; readonly label: string }> = [
  { step: "verifying-branch", label: "Verify semantic branch" },
  { step: "generating-metadata", label: "Prepare commit and pull request" },
  { step: "staging", label: "Stage session changes" },
  { step: "committing", label: "Create commit" },
  { step: "authenticating", label: "Authenticate with GitHub App" },
  { step: "pushing", label: "Push branch" },
  { step: "resolving-pr", label: "Find existing pull request" },
  { step: "creating-pr", label: "Create pull request" },
  { step: "updating-pr", label: "Update pull request description" },
  { step: "linking", label: "Link pull request to session" }
]

const publishStepLabel = (step: PublishStep): string =>
  PUBLISH_PROGRESS.find((candidate) => candidate.step === step)?.label ?? step

export interface PullRequestViewProps {
  pr: PullRequest | null
  connected: boolean
  /** Why this repository cannot use GitHub, derived from live installation access. */
  connectionMessage?: string
  connectionActionLabel?: string
  busy?: boolean
  /** The authenticated GitHub login — to detect the viewer's own PR (no self-approve). */
  viewerLogin?: string | null
  /** Authoritative main-process publish progress. */
  publish?: PublishCheckpoint | null
  publishing?: boolean
  branch?: string
  /** The owning session's title, for the "routed to <session>" copy. */
  sessionTitle?: string
  onCreatePr?: () => Promise<void> | void
  onRetryPublish?: () => void
  onConnectGithub?: () => void
  onSubmitReview?: (input: { body: string; kind: ReviewSubmitKind; routeToAgent: boolean }) => Promise<void> | void
  onSendEntryToAgent?: (entryId: string) => Promise<void> | void
  /** Timeline entry ids already routed to the agent — their action stays "Sent". */
  sentEntryIds?: ReadonlySet<string>
  /** Resolve / unresolve an inline review thread. */
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<void> | void
  /** Reply into an inline review thread (`commentId` = the REST databaseId). */
  onReplyToThread?: (commentId: number, body: string) => Promise<void> | void
  onOpenOnGithub?: () => void
  /** Open an existing session for this PR or start the prefilled creation flow. */
  onOpenSession?: () => void
  sessionActionLabel?: string
  sessionActionDisabledReason?: string
  onComment?: (body: string) => Promise<void> | void
  onClosePr?: () => Promise<void> | void
  closing?: boolean
  closeError?: string | null
  /** Open this PR's changed files in Jingler or GitHub. */
  onOpenFiles?: () => void
  onMerge?: (method: PrMergeMethod) => Promise<void> | void
  /** A merge is in flight — disables the button and shows a spinner. */
  merging?: boolean
  /** A failed GitHub API merge, shown beneath the merge button. */
  mergeError?: string | null
  /** Flip a draft PR to ready for review (shown only while the PR is a draft). */
  onMarkReady?: () => void
  /** A mark-ready is in flight — disables the button and shows a spinner. */
  markingReady?: boolean
  /** A failed mark-ready API mutation, shown beneath the button. */
  markReadyError?: string | null
  /** Merge the base into the head — offered only while the branch is behind. */
  onUpdateBranch?: () => void
  updatingBranch?: boolean
  updateBranchError?: string | null
  /** Hide session-bound review and merge actions for global/read-only views. */
  readOnly?: boolean
  /** The adversarial review panel's state + actions (right rail). */
  review?: PrSidePanelProps["review"]
}

/**
 * The Pull Request tab — PR header, review timeline, and a sticky review composer
 * in the centre column, with reviewers / checks / merge state in the right rail.
 * Pure presentational: all data + actions come through props.
 */
export function PullRequestView({
  pr,
  connected,
  connectionMessage,
  connectionActionLabel = "Connect GitHub",
  busy = false,
  viewerLogin,
  publish,
  publishing = false,
  branch,
  onCreatePr,
  onRetryPublish,
  onConnectGithub,
  onSubmitReview,
  onSendEntryToAgent,
  sentEntryIds,
  onResolveThread,
  onReplyToThread,
  onOpenOnGithub,
  onOpenSession,
  sessionActionLabel = "Create session",
  sessionActionDisabledReason,
  onComment,
  onClosePr,
  closing = false,
  closeError,
  onOpenFiles,
  onMerge,
  merging = false,
  mergeError,
  onMarkReady,
  markingReady = false,
  markReadyError,
  onUpdateBranch,
  updatingBranch = false,
  updateBranchError,
  readOnly = false,
  review
}: PullRequestViewProps) {
         function renderDetailsToggle() {
           return (!roomy && (
        <button
          type="button"
          aria-label={railOpen ? "Close pull request details" : "Pull request details"}
          aria-pressed={railOpen}
          title={
            railOpen
              ? "Close details"
              : readOnly && !onMerge
                ? "Reviewers and checks"
                : "Reviewers, checks and merge"
          }
          onClick={() => setRailOpen((v) => !v)}
          className={cn(
            "absolute right-2 top-2 z-40 flex size-7 items-center justify-center rounded-md border border-line bg-sunken shadow-lg transition-colors",
            railOpen ? "text-blue" : "text-dim hover:text-text-bright"
          )}
        >
          <PanelRight size={15} />
        </button>
      ))
         }

  function renderPullRequestBody(pr: NonNullable<PullRequestViewProps["pr"]>) {
    return (<div className="flex min-w-0 flex-1 flex-col">
        {/*
          Same reading column as the Conversation view — 760px, centred, on a
          30px gutter, with the scrollbar gutter reserved on BOTH edges so the
          column sits on the window's true centre axis rather than shifting when
          a scrollbar appears. Switching tabs shouldn't move the text you were
          reading, and an unbounded column made PR bodies and review comments run
          to line lengths nothing else in the app does.
        */}
        <div className="flex flex-1 flex-col overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
          <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-[18px]">
            {publish?.step === "failed" && (
              <div
                aria-live="polite"
                className="w-full rounded-lg border border-line bg-surface p-3 text-left text-[11px] text-muted-foreground"
              >
                <p className="font-medium text-text-bright">Publishing stopped</p>
                {publish.error && <Callout tone="red" className="mt-2">{publish.error}</Callout>}
                {onRetryPublish && (
                  <Button variant="secondary" size="sm" className="mt-3" onClick={onRetryPublish}>
                    Retry from {publish.resumeFrom ?? "inspection"}
                  </Button>
                )}
              </div>
            )}
          {/* PR header */}
          <div className="flex flex-col gap-[11px]">
            <div className="flex items-center gap-[9px]">
              <StatePill state={pr.state} />
              <span className="font-mono text-[12px] text-dim">#{pr.number}</span>
              <div className="flex-1" />
              {onOpenSession && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(sessionActionDisabledReason)}
                  title={sessionActionDisabledReason}
                  onClick={onOpenSession}
                >
                  <Download size={14} aria-hidden />
                  {sessionActionLabel}
                </Button>
              )}
              {onOpenOnGithub && (
                <button
                  type="button"
                  onClick={onOpenOnGithub}
                  className="font-mono text-[11px] text-dim hover:text-text"
                >
                  Open on GitHub ↗
                </button>
              )}
            </div>
            <h2 className="text-pretty text-[20px] font-bold tracking-[-0.2px] text-text-bright">
              {pr.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-[10px] gap-y-1.5 font-mono text-[11.5px] text-muted-foreground">
              <Badge tone="neutral" size="sm">
                {pr.headRefName} → {pr.baseRefName}
              </Badge>
              <DiffStat added={pr.additions} removed={pr.deletions} />
              <span className="text-line">|</span>
              <span>{pr.commits} commits</span>
              <span className="text-line">·</span>
              <span>{pr.changedFiles} files</span>
              <span className="text-line">·</span>
              <span>
                opened {relativeTime(pr.createdAt)} by {pr.author.login}
              </span>
            </div>
            {pr.labels.length > 0 && (
              <div className="flex flex-wrap gap-[7px]">
                {pr.labels.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))}
              </div>
            )}
            <MotionTabs
              className="pt-1"
              variant="underline"
              value={evidence}
              onChange={(value) => {
                if (value === "files") onOpenFiles?.()
                else setEvidence(value)
              }}
              items={[
                { value: "overview", label: "Overview" },
                { value: "commits", label: `Commits ${pr.commits}` },
                { value: "checks", label: `Checks ${pr.checks.length}` },
                { value: "files", label: `Files changed ${pr.changedFiles}`, disabled: !onOpenFiles }
              ]}
            />
          </div>

          {renderReviewEvidence(pr)}
          </div>
        </div>
      </div>)
  }

         function renderReviewEvidence(pr: NonNullable<PullRequestViewProps["pr"]>) {
           if (evidence === "commits") return (<CommitEvidence pr={pr} />)
return (evidence === "checks" ? (
            <CheckEvidence pr={pr} />
          ) : (
          <>
          {/*
            The PR description — the opening comment, rendered as one.
            `pr.body` was fetched, mapped and carried in the schema all along and
            simply never drawn, so this view opened straight onto the review
            timeline: the case FOR the change was the one thing missing from the
            page reviewing it. Presented as a timeline card (not a bare
            paragraph) because on GitHub it IS the first comment, and the author
            + timestamp are what let you tell a stale description from a current
            one.
          */}
          {pr.body !== null && pr.body.trim().length > 0 && (
            <Card>
              <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-[11px]">
                <Avatar
                  initial={pr.author.login.charAt(0).toUpperCase()}
                  src={githubAvatarUrl(pr.author.login)}
                  tone="orange"
                  size={22}
                />
                <span className="text-[13px] font-semibold text-text-bright">
                  {pr.author.login}
                </span>
                <span className="text-[11.5px] text-muted-foreground">opened this</span>
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-dim">
                  {relativeTime(pr.createdAt)}
                </span>
              </div>
              <div className="px-[14px] py-[11px]">
                <Markdown className="text-[13.5px]" repository={/github\.com\/([^/]+\/[^/]+)\//.exec(pr.url)?.[1]}>{pr.body}</Markdown>
              </div>
            </Card>
          )}

          <div className="h-px bg-line" />

          {/* Timeline — top-level reviews/comments and inline thread groups, interleaved */}
          {feed.length === 0 ? (
            <p className="text-[13px] text-dim">No reviews or comments yet.</p>
          ) : (
            feed.map((entry) =>
              entry.kind === "item" ? (
                <PrTimelineEntry
                  key={entry.item.id}
                  item={entry.item}
                  sent={sentEntryIds?.has(entry.item.id)}
                  onSendToAgent={onSendEntryToAgent}
                />
              ) : (
                <PrReviewGroup
                  key={entry.id}
                  threads={entry.threads}
                  prAuthor={pr.author.login}
                  sentEntryIds={sentEntryIds}
                  onSendToAgent={onSendEntryToAgent}
                  onResolve={onResolveThread}
                  onReply={onReplyToThread}
                />
              )
            )
          )}

          {/* Sticky review/comment composer */}
          {(!readOnly || onComment) && (
            <div className="sticky bottom-0 mt-auto pt-2">
              <PrReviewComposer
                connected={connected}
                commentOnly={readOnly}
                selfAuthored={Boolean(viewerLogin) && viewerLogin === pr.author.login}
                onSubmit={(input) =>
                  readOnly ? onComment?.(input.body) : onSubmitReview?.(input)
                }
              />
            </div>
          )}
          </>
          ))
         }

         function renderCreatePullRequest() {
           return (<div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-surface text-dim">
          <GitPullRequest size={26} />
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-balance text-[15px] font-semibold text-text-bright">
            No pull request yet for this branch
          </h2>
          <p className="max-w-xs text-[13px] text-muted-foreground">
            Open a pull request to run CI, collect reviews, and route feedback back to the agent.
          </p>
        </div>
        {connected ? (
          onCreatePr ? (
            <div className="flex w-full max-w-sm flex-col items-center gap-3">
              <Button
                size="md"
                disabled={busy || publishing}
                onClick={() => onCreatePr()}
              >
                <GitPullRequest size={14} />
                {getPublishing()}
              </Button>
              {branch && <p className="text-[11px] text-muted-foreground">Branch: <code>{branch}</code></p>}
              {publish && publish.step !== "idle" && (
                <div
                  aria-live="polite"
                  className="w-full rounded-lg border border-line bg-surface p-3 text-left text-[11px] text-muted-foreground"
                >
                  <p className="font-medium text-text-bright">
                    {getStep(publish)}
                  </p>
                  <ol className="mt-2 flex flex-col gap-1.5">
                    {PUBLISH_PROGRESS.map(({ step, label }) => {
                      const done = publish.completed.includes(step)
                      const active = publish.step === step || publish.resumeFrom === step
                      return (
                        <li
                          key={step}
                          className={cn("flex items-center gap-2", active && "font-medium text-text-bright")}
                        >
                          <span className="flex size-3.5 shrink-0 items-center justify-center">
                            {done ? <Check size={12} aria-hidden /> : active && publishing ? <Spinner size={12} /> : "·"}
                          </span>
                          <span>{label}</span>
                        </li>
                      )
                    })}
                  </ol>
                  {publish.error && <Callout tone="red" className="mt-2">{publish.error}</Callout>}
                  {publish.step === "failed" && onRetryPublish && (
                    <Button variant="secondary" size="sm" className="mt-3" onClick={onRetryPublish}>
                      Retry from {publish.resumeFrom ?? "inspection"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Callout tone="blue">
              Direct sessions work on their selected branch, so Jingler cannot
              open a pull request from that branch to itself.
            </Callout>
          )
        ) : (
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Callout tone="blue">
              {connectionMessage ?? "Connect GitHub to create and review pull requests."}
            </Callout>
            <Button variant="secondary" className="self-center" onClick={onConnectGithub}>
              {connectionActionLabel}
            </Button>
          </div>
        )}
      </div>)
         }

         function getStep(publish: PublishCheckpoint) {
           if (publish.step === "failed") return ("Publishing stopped")
           if (publish.step === "no-changes") return ("Nothing to publish")
           if (publish.step === "complete" && publish.prNumber !== undefined) return (`Pull request #${publish.prNumber} linked`)
           return (`Current step: ${publishStepLabel(publish.step)}`)
         }

         function getPublishing() {
           if (publishing) return ("Publishing…")
           if (publish?.step === "failed") return ("Try publishing again")
           if (publish && !["idle", "complete", "no-changes"].includes(publish.step)) return ("Resume publishing")
           return ("Publish pull request")
         }

  // Declared ABOVE the early returns below — this component returns early for
  // the loading and no-PR states, and a hook after those runs on some renders
  // and not others, which is the one thing React's hook order cannot survive.
  //
  // Below `wide` the 352px rail floats instead of docking: the centre column is a
  // 760px reading measure with 60px of gutter, so a docked rail in a 500px pane
  // left roughly 88px of it — narrower than the PR title.
  const roomy = atLeast(useWidthTier(), "wide")
  const [railOpen, setRailOpen] = useState(false)
  const [evidence, setEvidence] = useState<PrEvidence>("overview")
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  useEffect(() => {
    if (roomy) setRailOpen(false)
  }, [roomy])
  useEffect(() => {
    if (!railOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOpen(false)
    }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [railOpen])

  // Loading — avoid flashing the "Create PR" empty state before the PR resolves.
  if (pr === null && busy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Spinner size={20} />
        <span className="text-[13px]">Loading pull request…</span>
      </div>
    )
  }
  if (pr === null) {
    return (
      renderCreatePullRequest()
    )
  }

  // Not memoized: the early returns above rule out a hook here, and this is a
  // map + sort over a handful of entries.
  const feed = buildFeed(pr)

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {onClosePr && (
        <ConfirmDialog
          open={closeConfirmOpen}
          onOpenChange={setCloseConfirmOpen}
          title={`Close pull request #${pr.number}?`}
          description="The pull request can be reopened later on GitHub."
          confirmLabel="Close pull request"
          tone="danger"
          onConfirm={async () => {
            try {
              await onClosePr()
            } catch (cause) {
              setCloseConfirmOpen(false)
              throw cause
            }
          }}
        />
      )}
      {/* Centre column: header + timeline + sticky composer */}
      {renderPullRequestBody(pr)}

      {/* Right rail — docked when there's room, a floating sheet when not. */}
      {renderDetailsToggle()}
      <PrSidePanel
        // The rail holds the merge button, so it can't just be dropped at narrow
        // widths — it has to remain reachable, which is what the toggle above is
        // for. Hidden rather than unmounted so its scroll position and merge-
        // method choice survive being closed.
        className={cn(!roomy && "absolute inset-y-0 right-0 z-30 shadow-2xl", !(roomy || railOpen) && "hidden")}
        pr={pr}
        connected={connected}
        onMerge={onMerge}
        merging={merging}
        mergeError={mergeError}
        onClosePr={onClosePr ? () => setCloseConfirmOpen(true) : undefined}
        closing={closing}
        closeError={closeError}
        onMarkReady={onMarkReady}
        markingReady={markingReady}
        markReadyError={markReadyError}
        onUpdateBranch={onUpdateBranch}
        updatingBranch={updatingBranch}
        updateBranchError={updateBranchError}
        review={review}
        readOnly={readOnly && !onMerge}
      />
    </div>
  )
}

function CommitEvidence({ pr }: { pr: PullRequest }) {
  const commits = pr.commitItems ?? []
  if (commits.length === 0) {
    return <p className="text-[13px] text-dim">No commit details reported.</p>
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {commits.map((commit) => (
        <a
          key={commit.sha}
          href={commit.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-3 border-b border-hairline px-4 py-3 last:border-b-0 hover:bg-surface"
        >
          <GitCommit className="mt-0.5 size-4 flex-none text-dim" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-text-bright">{commit.message}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">{commit.author} committed {relativeTime(commit.committedAt)}</span>
          </span>
          {commit.verified && <Badge tone="green" size="xs">Verified</Badge>}
          <code className="font-mono text-[10.5px] text-dim">{commit.sha.slice(0, 7)}</code>
        </a>
      ))}
    </div>
  )
}

function CheckEvidence({ pr }: { pr: PullRequest }) {
  if (pr.checks.length === 0) {
    return <p className="text-[13px] text-dim">No checks reported.</p>
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      {pr.checks.map((check) => <PrCheckRow key={check.name.toLowerCase()} check={check} />)}
    </div>
  )
}
