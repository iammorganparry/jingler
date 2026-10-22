import { useEffect, useState, type ReactNode } from "react"
import type {
  IssueReference,
  PrMergeMethod,
  SessionPr,
  PrReviewThread,
  PrTimelineItem,
  PublishCheckpoint,
  PublishStep,
  PullRequest,
  ReviewComment,
  ReviewSubmitKind
} from "@jingler/core"
import { GitCommit, GitPullRequest, PanelRight } from "lucide-react"
import { Stepper } from "../components/status-row.js"
import { cn } from "../lib/cn.js"
import { useContainerWidth } from "../hooks/use-container-width.js"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "../components/drawer.js"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Card } from "../components/card.js"
import { Eyebrow } from "../components/eyebrow.js"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { Markdown } from "../components/markdown.js"
import { Callout } from "../components/callout.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { MotionTabs } from "../components/beui/controls.js"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/beui/select.js"
import { PrCheckRow } from "./pr-check-row.js"
import { PrReviewComposer } from "./pr-review-composer.js"
import { PrReviewGroup } from "./pr-review-group.js"
import { ReadinessChecklist } from "./readiness-checklist.js"
import { LabelChip, PrSidePanel, type PrSidePanelProps } from "./pr-side-panel.js"
import { WorkflowSection } from "./workflow-section.js"
import { PrTimelineEntry } from "./pr-timeline-entry.js"
import { PrStackRail, type PrStackNav } from "./pr-stack-rail.js"
import { PrSwitcher } from "./pr-switcher.js"
import { PrViewHeader } from "./pr-view-header.js"
import { ReviewDrawer, useReviewDrawer, type ReviewRun } from "./review-drawer.js"
import { addedDrafts, draftsToReviewComments, type ReviewFindingDraft } from "./review-drawer-machine.js"

type PrEvidence = "overview" | "commits" | "checks" | "files"

/** Conversation and Checks carry the readiness checklist; Commits and Files do not. */
const showsReadiness = (evidence: PrEvidence) => evidence !== "commits" && evidence !== "files"

/** Files opens in place when a panel is supplied, otherwise hands off to `onOpenFiles`. */
function selectEvidence(value: string, panel: ReactNode, onOpenFiles: (() => void) | undefined, set: (value: PrEvidence) => void) {
  if (value === "files" && !panel) onOpenFiles?.()
  else set(value as PrEvidence)
}

const evidenceTabs = (pr: PullRequest, onOpenFiles: (() => void) | undefined, filesPanel: ReactNode) => [
  { value: "overview", label: "Conversation" },
  { value: "commits", label: `Commits ${pr.commits}` },
  { value: "files", label: `Files ${pr.changedFiles}`, disabled: !(onOpenFiles ?? filesPanel) },
  { value: "checks", label: checksLabel(pr) }
]

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

type PublishPhase = "commit" | "push" | "open-pr"

const PUBLISH_PHASE_LABELS: Record<PublishPhase, string> = {
  commit: "Commit",
  push: "Push",
  "open-pr": "Open PR"
}

const publishPhaseFromStep = (step: PublishStep): PublishPhase | null => {
  if (step === "idle" || step === "complete" || step === "failed" || step === "no-changes") return null
  if (step === "verifying-branch" || step === "generating-metadata" || step === "staging" || step === "committing") return "commit"
  if (step === "inspecting" || step === "authenticating" || step === "pushing") return "push"
  return "open-pr"
}

const PUBLISH_PHASES: ReadonlyArray<PublishPhase> = ["commit", "push", "open-pr"]

function PublishStepper({ publish }: { publish: PublishCheckpoint }) {
  const active = publishPhaseFromStep(publish.step) ?? (publish.resumeFrom ? publishPhaseFromStep(publish.resumeFrom) : null)
  const current = publish.step === "complete" ? PUBLISH_PHASES.length : active ? PUBLISH_PHASES.indexOf(active) : 0
  return <Stepper className="mt-2" steps={PUBLISH_PHASES.map((phase) => PUBLISH_PHASE_LABELS[phase])} current={current} />
}

/** Loading skeleton or retryable error while there is no PR yet; null once the Create-PR / PR views can render. */
function renderLoadState(pr: PullRequest | null, connected: boolean, busy: boolean, loadError: string | null | undefined, onRetryLoad?: () => void) {
  // Not connected: fall through to the not-connected panel — a read would only fail.
  if (pr !== null || !connected) return null
  // Avoid flashing the "Create PR" empty state before the PR resolves.
  if (busy) {
    return (
      <div aria-label="Loading pull request" className="flex flex-1 flex-col gap-[18px] px-[30px] py-[26px]">
        <ListSkeleton rows={5} rowHeight={28} gap={12} />
      </div>
    )
  }
  if (!loadError) return null
  return (
    <div className="flex flex-1 flex-col px-[30px] py-[26px]">
      <InlineError message={loadError} onRetry={onRetryLoad} />
    </div>
  )
}

export interface PullRequestViewProps {
  pr: PullRequest | null
  connected: boolean
  /** Why this repository cannot use GitHub, derived from live installation access. */
  connectionMessage?: string
  connectionActionLabel?: string
  busy?: boolean
  /** The PR failed to load — shown with Retry instead of the Create PR empty state. */
  loadError?: string | null
  onRetryLoad?: () => void
  /** The authenticated GitHub login — to detect the viewer's own PR (no self-approve). */
  viewerLogin?: string | null
  /** Authoritative main-process publish progress. */
  publish?: PublishCheckpoint | null
  publishing?: boolean
  branch?: string
  /** The session base branch (e.g., "main"). */
  baseBranch?: string
  /** The session PR stack (ordered, bottom layer first). */
  prs?: ReadonlyArray<SessionPr>
  /** Present when the session holds a PR stack: enables the header switcher and the Checks rail. */
  stack?: PrStackNav
  /** The owning session's title, for the "routed to <session>" copy. */
  sessionTitle?: string
  onCreatePr?: (base?: string) => Promise<void> | void
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
  /** This PR's own changed files; when set, the Files tab shows it in place instead of calling `onOpenFiles`. */
  filesPanel?: ReactNode
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
  /** The PR's conflicting files, named in the "Ask agent to resolve conflicts" prompt. */
  conflictedFiles?: PrSidePanelProps["conflictedFiles"]
  onResolveConflicts?: PrSidePanelProps["onResolveConflicts"]
  /** The workspace setup/run lifecycle — collapsed Workflow section in the rail. */
  workflow?: PrSidePanelProps["workflow"]
  /** The issue this PR closes, shown in the rail. */
  linkedIssue?: IssueReference
  /** Draft review findings. Supplying this (even empty) enables the Review drawer — sidebar inbox only. */
  reviewDrafts?: ReadonlyArray<ReviewFindingDraft>
  /** The live review producing `reviewDrafts`; started when the drawer first opens. */
  reviewRun?: ReviewRun
  /** Promote the drawer review to a session; receives the markdown summary of the drafts. */
  onPromoteReview?: (summary: string) => void
  /** Post added drafts as inline comments on a PR with no session (inbox). */
  onSubmitInlineReview?: (input: { body: string; comments: ReadonlyArray<ReviewComment> }) => Promise<void> | void
}

/**
 * The Pull Request tab — PR header, review timeline, and a sticky review composer
 * in the centre column, with reviewers / checks / merge state in the right rail.
 * Pure presentational: all data + actions come through props.
 */
/** The PR description rendered as the opening comment; placeholder when empty. */
function PrDescriptionCard({ pr, repository }: { pr: PullRequest; repository?: string }) {
  return (
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
                {pr.body?.trim() ? (
                  <Markdown className="text-[13.5px]" repository={repository}>{pr.body}</Markdown>
                ) : (
                  <p className="text-[13.5px] text-muted-foreground">No description provided.</p>
                )}
              </div>
          </Card>
  )
}

/** Below this container width the rail collapses into a sheet. */
const RAIL_COLLAPSE_BELOW = 900

/**
 * Measures its own box (not the window) so a narrow split pane collapses the
 * rail even on a wide display. Width 0 is the pre-measurement frame: stay docked.
 */
export function PullRequestView(props: PullRequestViewProps) {
  const [ref, width] = useContainerWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1">
      <PullRequestViewBody {...props} compact={width !== 0 && width < RAIL_COLLAPSE_BELOW} />
    </div>
  )
}

function PullRequestViewBody({
  compact,
  pr,
  connected,
  connectionMessage,
  connectionActionLabel = "Connect GitHub",
  busy = false,
  loadError,
  onRetryLoad,
  viewerLogin,
  publish,
  publishing = false,
  branch,
  baseBranch,
  prs,
  stack,
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
  filesPanel,
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
  review,
  conflictedFiles,
  onResolveConflicts,
  workflow,
  linkedIssue,
  reviewDrafts,
  reviewRun,
  onPromoteReview,
  onSubmitInlineReview
}: PullRequestViewProps & { compact: boolean }) {
  const drawer = useReviewDrawer(reviewDrafts, reviewRun)
  const onReview = drawer.enabled ? () => drawer.send({ type: "TOGGLE" }) : undefined
         function renderDetailsToggle() {
           return (
        <DrawerTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="Pull request details"
            title={readOnly && !onMerge ? "Reviewers and checks" : "Reviewers, checks and merge"}
            className="absolute right-2 top-2 z-40 size-7"
          >
            <PanelRight size={15} />
          </Button>
        </DrawerTrigger>
      )
         }

  function renderPullRequestBody(pr: NonNullable<PullRequestViewProps["pr"]>) {
    return (<div className="flex min-w-0 flex-1 flex-col">
        {/*
          Same reading column as the shared ReadingShell — 720px, centred, on a
          30px gutter, with the scrollbar gutter reserved on BOTH edges so the
          column sits on the window's true centre axis rather than shifting when
          a scrollbar appears. Switching tabs shouldn't move the text you were
          reading, and an unbounded column made PR bodies and review comments run
          to line lengths nothing else in the app does.
        */}
        <div className="flex flex-1 flex-col overflow-auto px-[30px] py-[26px] [scrollbar-gutter:stable_both-edges]">
          <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-[18px]">
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
            <PrViewHeader
              pr={pr}
              onOpenSession={onOpenSession}
              sessionActionLabel={sessionActionLabel}
              sessionActionDisabledReason={sessionActionDisabledReason}
              onOpenOnGithub={onOpenOnGithub}
              onMarkReady={readOnly && !onMerge ? undefined : onMarkReady}
              markingReady={markingReady}
              onRequestClose={onClosePr && !(readOnly && !onMerge) ? () => setCloseConfirmOpen(true) : undefined}
              onReview={onReview}
              switcher={stack ? <PrSwitcher {...stack} /> : undefined}
            />
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
              size="sm"
              ariaLabel="Pull request sections"
              value={evidence}
              onChange={(value) => selectEvidence(value, filesPanel, onOpenFiles, setEvidence)}
              items={evidenceTabs(pr, onOpenFiles, filesPanel)}
            />
          </div>

          {showsReadiness(evidence) && <ReadinessChecklist pr={pr} />}
          {renderReviewEvidence(pr)}
          </div>
        </div>
      </div>)
  }

         function renderReviewEvidence(pr: NonNullable<PullRequestViewProps["pr"]>) {
           if (evidence === "commits") return (<CommitEvidence pr={pr} />)
           if (evidence === "files" && filesPanel) return filesPanel
return (evidence === "checks" ? (
            <CheckEvidence pr={pr} stack={stack} />
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
          <PrDescriptionCard pr={pr} repository={repository} />

          {/* Timeline — top-level reviews/comments and inline thread groups, interleaved */}
          <Eyebrow>Timeline</Eyebrow>
          {feed.length === 0 ? (
            <EmptyState title="No reviews or comments yet" description="Reviews and comments on this pull request will appear here." />
          ) : (
            feed.map((entry) =>
              entry.kind === "item" ? (
                <PrTimelineEntry
                  key={entry.item.id}
                  item={entry.item}
                  repository={repository}
                  sent={sentEntryIds?.has(entry.item.id)}
                  onSendToAgent={onSendEntryToAgent}
                />
              ) : (
                <PrReviewGroup
                  key={entry.id}
                  threads={entry.threads}
                  prAuthor={pr.author.login}
                  repository={repository}
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
                pending={addedDrafts(drawer.context)}
                onSubmitted={() => drawer.send({ type: "SUBMITTED" })}
                selfAuthored={Boolean(viewerLogin) && viewerLogin === pr.author.login}
                onSubmit={(input) =>
                  readOnly && onSubmitInlineReview && input.pending.length > 0
                    ? onSubmitInlineReview({ body: input.inlineBody, comments: draftsToReviewComments(input.pending) })
                    : readOnly ? onComment?.(input.body) : onSubmitReview?.(input)
                }
              />
            </div>
          )}
          </>
          ))
         }

         // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing complexity
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
                onClick={() => onCreatePr(selectedBase)}
              >
                <GitPullRequest size={14} />
                {getPublishing()}
              </Button>
              {branch && <p className="text-[11px] text-muted-foreground">Branch: <code>{branch}</code></p>}
              {(baseBranch || (prs && prs.length > 0)) && (
                <div className="flex w-full flex-col gap-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Base
                  </label>
                  <Select
                    value={selectedBase}
                    onValueChange={setSelectedBase}
                  >
                    <SelectTrigger
                      className="h-8 text-xs"
                      aria-label="Select base branch for pull request"
                    >
                      <SelectValue placeholder="Select base branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {baseBranch && (
                        <SelectItem value={baseBranch}>
                          {baseBranch}
                        </SelectItem>
                      )}
                      {prs?.map((pr) => pr.branch && (
                        <SelectItem key={pr.number} value={pr.branch}>
                          Stack on #{pr.number}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {publish && publish.step !== "idle" && (
                <div
                  aria-live="polite"
                  className="w-full rounded-lg border border-line bg-surface p-3 text-left text-[11px] text-muted-foreground"
                >
                  <p className="font-medium text-text-bright">
                    {getStep(publish)}
                  </p>
                  <PublishStepper publish={publish} />
                  {publish.error && <Callout tone="red" className="mt-2">{publish.error}</Callout>}
                  {publish.step === "failed" && onRetryPublish && (
                    <Button variant="secondary" size="sm" className="mt-3" onClick={onRetryPublish}>
                      Retry from {publish.resumeFrom ? PUBLISH_PHASE_LABELS[publishPhaseFromStep(publish.resumeFrom) ?? "commit"] : "inspection"}
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
           const phase = publishPhaseFromStep(publish.step)
           return phase ? `Current step: ${PUBLISH_PHASE_LABELS[phase]}` : "Publishing"
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
  const [railOpen, setRailOpen] = useState(false)
  // Base branch choice for stacking PRs
  const [selectedBase, setSelectedBase] = useState<string | undefined>(() => {
    const topPr = prs && prs.length > 0 ? prs[prs.length - 1] : undefined
    return topPr?.branch ?? baseBranch
  })
  const [evidence, setEvidence] = useState<PrEvidence>("overview")
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  useEffect(() => {
    if (!compact) setRailOpen(false)
  }, [compact])

  const loadView = renderLoadState(pr, connected, busy, loadError, onRetryLoad)
  if (loadView) return loadView
  if (pr === null) {
    // Workspace setup/run is independent of whether a PR exists yet — a
    // worktree session reaches the Checks tab before publishing, and that's
    // exactly when setup is most likely to still need a retry or skip.
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {renderCreatePullRequest()}
        {workflow && (
          <div className="flex w-[280px] flex-none flex-col border-l border-hairline bg-panel">
            <WorkflowSection {...workflow} />
          </div>
        )}
      </div>
    )
  }

  // Not memoized: the early returns above rule out a hook here, and this is a
  // map + sort over a handful of entries.
  const feed = buildFeed(pr)
  const repository = /github\.com\/([^/]+\/[^/]+)\//.exec(pr.url)?.[1]

  function renderRail(pr: PullRequest) {
    if (drawer.open) return <ReviewDrawer pr={pr} drawer={drawer} onPromote={onPromoteReview} />
    if (!compact) return sidePanel
    return (
      <Drawer open={railOpen} onOpenChange={setRailOpen}>
        {renderDetailsToggle()}
        <DrawerContent className="w-[280px]">
          <DrawerTitle className="sr-only">Pull request details</DrawerTitle>
          <DrawerDescription className="sr-only">Reviewers, checks and merge</DrawerDescription>
          {sidePanel}
        </DrawerContent>
      </Drawer>
    )
  }

  const sidePanel = (
    <PrSidePanel
        className={compact ? "min-h-0 flex-1 border-l-0" : undefined}
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
        conflictedFiles={conflictedFiles}
        onResolveConflicts={onResolveConflicts}
        workflow={workflow}
        readOnly={readOnly && !onMerge}
        linkedIssue={linkedIssue}
        stack={stack}
      />
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {onClosePr && (
        <ConfirmDialog
          open={closeConfirmOpen}
          onOpenChange={setCloseConfirmOpen}
          title={`Close pull request #${pr.number}?`}
          description="The pull request can be reopened later on GitHub."
          confirmLabel="Close pull request"
          destructive
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

      {/* Right rail — docked at 280px, or a sheet below 900px opened from the header button. */}
      {renderRail(pr)}
    </div>
  )
}

/** `Checks 3/4` (passed/total), or bare `Checks` when none are reported. */
const checksLabel = (pr: PullRequest) =>
  pr.checks.length === 0 ? "Checks" : `Checks ${pr.checks.filter((c) => c.status === "pass").length}/${pr.checks.length}`

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

function CheckEvidence({ pr, stack }: { pr: PullRequest; stack?: PrStackNav }) {
  const checks =
    pr.checks.length === 0 ? (
      <EmptyState title="No checks reported" description="CI results will appear here once a run starts." />
    ) : (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
        {pr.checks.map((check) => <PrCheckRow key={check.name.toLowerCase()} check={check} />)}
      </div>
    )
  if (!stack) return checks
  return (
    <div className="flex items-start gap-6">
      <PrStackRail
        layers={stack.layers}
        selected={stack.selected}
        onSelect={stack.onSelect}
        mergeState={stack.mergeState}
        merged={stack.merged}
        mergeError={stack.mergeError}
        onMergeStack={stack.onMergeStack}
        onResume={stack.onResume}
        mergeMethod={stack.mergeMethod}
        onMergeMethod={stack.onMergeMethod}
        restacking={stack.restacking}
        onRestack={stack.onRestack}
      />
      <div className="min-w-0 flex-1">{checks}</div>
    </div>
  )
}
