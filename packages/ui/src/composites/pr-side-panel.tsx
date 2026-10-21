import { useState, type ReactNode } from "react"
import type { IssueReference, PrLabel, PrMergeMethod, PrReviewer, PrReviewKind, PullRequest } from "@jingler/core"
import { conflictResolutionPrompt } from "@jingler/core"
import type { BadgeProps } from "../components/badge.js"
import { cn } from "../lib/cn.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Spinner } from "../components/loading.js"
import { MergeSplitButton } from "./merge-split-button.js"
import type { PrStackNav } from "./pr-stack-rail.js"
import { ReviewFindings, type ReviewFindingsProps } from "./review-findings.js"
import { WorkflowSection, type WorkflowSectionProps } from "./workflow-section.js"

/** Reviewer state → Badge tone + label. */
const reviewerBadge: Record<PrReviewKind, { tone: BadgeProps["tone"]; label: string }> = {
  approved: { tone: "green", label: "approved" },
  changes_requested: { tone: "red", label: "changes requested" },
  commented: { tone: "blue", label: "commented" },
  pending: { tone: "count", label: "pending" }
}

/** The one blocker the operator can clear from the rail (see `collectMergeBlockers`). */
const BEHIND_BLOCKER = "Branch is out of date with the base"
/** Matches `collectMergeBlockers`'s "Merge conflicts" string in `github-mappers.ts`. */
const CONFLICTS_BLOCKER = "Merge conflicts"

/** A single PR label chip, tinted with the label's own colour when known. */
export function LabelChip({ label }: { label: PrLabel }) {
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

function RailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-none flex-col gap-[11px] border-b border-hairline p-4">
      <div className="flex items-center gap-2">
        <Eyebrow className="flex-1">{title}</Eyebrow>
        {aside}
      </div>
      {children}
    </div>
  )
}

function BlockerRow({ blocker, action }: { blocker: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-text">
      <span className="text-red">✗</span>
      <span className="min-w-0 flex-1">{blocker}</span>
      {action}
    </div>
  )
}

function ReviewerRow({ reviewer }: { reviewer: PrReviewer }) {
  const meta = reviewerBadge[reviewer.state]
  return (
    <div className="flex items-center gap-[9px]">
      <Avatar
        initial={reviewer.login.charAt(0).toUpperCase()}
        src={githubAvatarUrl(reviewer.login)}
        tone="dim"
        size={22}
      />
      <span className="flex-1 text-[13px] text-text-bright">{reviewer.login}</span>
      <Badge tone={meta.tone} size="sm">
        {meta.label}
      </Badge>
    </div>
  )
}

/**
 * The Pull Request right rail — reviewers, CI checks, and the merge box. Read-only
 * except for the merge action (enabled only when connected and unblocked).
 */
export interface PrSidePanelProps {
  pr: PullRequest
  connected: boolean
  /** Merge with the chosen strategy — the picker below decides which. */
  onMerge?: (method: PrMergeMethod) => Promise<void> | void
  merging?: boolean
  mergeError?: string | null
  onClosePr?: () => void
  closing?: boolean
  closeError?: string | null
  onMarkReady?: () => void
  markingReady?: boolean
  markReadyError?: string | null
  /** Merge the base into the head — offered only while the branch is behind. */
  onUpdateBranch?: () => void
  updatingBranch?: boolean
  updateBranchError?: string | null
  /** The files with merge conflicts — named in the "Ask agent to resolve conflicts" prompt. */
  conflictedFiles?: ReadonlyArray<string>
  /** Post a conflict-resolution prompt into the session's chat. */
  onResolveConflicts?: (prompt: string) => void
  /**
   * The adversarial review panel's state + actions. Omitted in contexts that
   * don't offer a review (e.g. a story showing the bare PR rail). `canRun` is
   * derived here from the PR's own state, so callers can't offer a review of a
   * merged/closed PR by accident.
   */
  review?: Omit<ReviewFindingsProps, "canRun">
  /** The workspace setup/run lifecycle — collapsed by default; omitted hides the section. */
  workflow?: WorkflowSectionProps
  /**
   * The rail's width in px. Was a hard `w-[352px]` — which, in a 500px pane,
   * left the PR body about 88px of reading column after its own 60px gutters.
   */
  width?: number
  /** The issue this PR closes — the section is hidden without one. */
  linkedIssue?: IssueReference
  /** The session PR stack — the section is hidden unless there are two or more layers. */
  stack?: Pick<PrStackNav, "layers" | "selected" | "onSelect">
  /** Hide session-bound lifecycle and merge controls. */
  readOnly?: boolean
  /** Extra classes — how the caller turns the rail into a floating sheet. */
  className?: string
}

export function PrSidePanel({
  pr,
  connected,
  onMerge,
  merging = false,
  mergeError,
  onClosePr,
  closing = false,
  closeError,
  onMarkReady,
  markingReady = false,
  markReadyError,
  onUpdateBranch,
  updatingBranch = false,
  updateBranchError,
  conflictedFiles = [],
  onResolveConflicts,
  review,
  workflow,
  width = 280,
  linkedIssue,
  stack,
  readOnly = false,
  className
}: PrSidePanelProps) {
  const [resolving, setResolving] = useState(false)
         function renderAdversarialReview() {
           return (review && (
        <div className="flex flex-none flex-col gap-3 border-b border-hairline p-4">
          <div className="flex items-center gap-2">
            <Eyebrow className="flex-1">Adversarial review</Eyebrow>
            {review.review && review.review.findings.length > 0 && (
              <span className="font-mono text-[10.5px] text-dim">
                {review.review.findings.length}{" "}
                {review.review.findings.length === 1 ? "finding" : "findings"}
              </span>
            )}
          </div>
          {/* A review needs a live PR to argue against — merged/closed PRs are
              history, and re-reviewing them just burns tokens. */}
          <ReviewFindings {...review} canRun={connected && !merged && !closed} />
        </div>
      ))
         }

function renderDraftActions() {
             return (<div className="flex flex-col gap-3">
            <Callout tone="blue">This pull request is a draft.</Callout>
            {onMarkReady && (
              <Button
                variant="secondary"
                className="w-full justify-center gap-2"
                disabled={!connected || markingReady}
                onClick={onMarkReady}
              >
                {markingReady && <Spinner size={13} />}
                {markingReady ? "Marking ready…" : "Mark ready for review"}
              </Button>
            )}
            {markReadyError && (
              <Callout tone="red" className="items-start">
                {markReadyError}
              </Callout>
            )}
          </div>)
           }

function renderConflictActions() {
  const hasConflicts = pr.mergeBlockers.includes(CONFLICTS_BLOCKER)
             return (<div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-red/30">
              <div className="flex items-center gap-[9px] border-b border-hairline bg-red/[0.06] px-[13px] py-[10px]">
                <span className="flex size-5 flex-none items-center justify-center rounded-full bg-red/20 text-[12px] text-red">
                  !
                </span>
                <span className="text-[13px] font-semibold text-text-bright">Merging blocked</span>
              </div>
              <div className="flex flex-col gap-1.5 px-[13px] py-[11px]">
                {/*
                  "Out of date" is the ONE blocker the operator can clear from here
                  with a direct GitHub mutation; branch protection needs a reviewer,
                  failing checks need a fix. Conflicts route to the session's own
                  agent instead, below. This updates the remote head only; the
                  worktree is left alone, since the agent may be mid-turn with
                  uncommitted work.
                */}
                {pr.mergeBlockers.map((blocker) => (
                  <BlockerRow
                    key={blocker}
                    blocker={blocker}
                    action={
                      behind && blocker === BEHIND_BLOCKER && onUpdateBranch ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="gap-2"
                          disabled={!connected || updatingBranch}
                          onClick={onUpdateBranch}
                        >
                          {updatingBranch && <Spinner size={13} />}
                          {updatingBranch ? "Updating…" : "Update branch"}
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </div>
              {hasConflicts && onResolveConflicts && (
                <div className="flex flex-col gap-1.5 border-t border-hairline px-[13px] py-[11px]">
                  {resolving ? (
                    <div className="flex items-center gap-2 text-[12px] text-text">
                      <Spinner size={13} />
                      <span>
                        Agent is resolving…{" "}
                        <span className="text-dim">{conflictedFiles.join(", ")}</span>
                      </span>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full justify-center gap-2"
                      disabled={!connected || conflictedFiles.length === 0}
                      onClick={() => {
                        onResolveConflicts(conflictResolutionPrompt(conflictedFiles))
                        setResolving(true)
                      }}
                    >
                      Ask agent to resolve conflicts
                    </Button>
                  )}
                </div>
              )}
              {updateBranchError && (
                <div className="px-[13px] pb-[13px]">
                  <Callout tone="red" className="items-start">
                    {updateBranchError}
                  </Callout>
                </div>
              )}
            </div>
            <MergeSplitButton
              connected={connected}
              onMerge={onMerge}
              merging={merging}
              blockedReason={pr.mergeBlockers[0]}
              mergeError={mergeError}
            />
          </div>)
           }

         function getMerged() {




           if (merged) return (<Callout tone="purple">This pull request has been merged.</Callout>)
           if (closed) return (<Callout tone="red">This pull request is closed.</Callout>)
           if (draft) return (renderDraftActions())
           if (blocked) return (renderConflictActions())
           return (<div className="flex flex-col gap-3">
            <Callout tone="blue">This branch has no conflicts and can be merged.</Callout>
            <MergeSplitButton
              connected={connected}
              onMerge={onMerge}
              merging={merging}
              mergeError={mergeError}
            />
          </div>)
         }

  const failing = pr.checks.filter((c) => c.status === "fail").length
  const blocked = pr.mergeBlockers.length > 0
  const behind = pr.mergeStateStatus === "BEHIND"
  const merged = pr.state === "merged"
  const closed = pr.state === "closed"
  const draft = pr.state === "draft"

  return (
    // The panel itself no longer scrolls. Only the sections ABOVE the merge box
    // do, so the merge action stays pinned to the bottom and reachable at any
    // scroll position — a long adversarial review used to push it off-screen,
    // which is exactly when you most want to merge.
    <div
      style={{ width }}
      className={cn(
        "flex flex-none flex-col overflow-hidden border-l border-hairline bg-panel",
        className
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {pr.reviewers.length > 0 && (
        <RailSection title="Reviewers">
          {pr.reviewers.map((r) => <ReviewerRow key={r.login} reviewer={r} />)}
        </RailSection>
      )}

      {pr.labels.length > 0 && (
        <RailSection title="Labels">
          <div className="flex flex-nowrap gap-1.5 overflow-hidden">
            {pr.labels.map((label) => <LabelChip key={label.name} label={label} />)}
          </div>
        </RailSection>
      )}

      {pr.checks.length > 0 && (
        <RailSection
          title="Checks"
          aside={failing > 0 && <span className="font-mono text-[10.5px] text-red">{failing} failing</span>}
        >
          <span className="text-[12px] text-text">
            {pr.checks.filter((c) => c.status === "pass").length}/{pr.checks.length} passing
          </span>
        </RailSection>
      )}

      {linkedIssue && (
        <RailSection title="Linked issue">
          <a
            href={linkedIssue.url}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-text hover:text-text-bright"
          >
            <span className="font-mono text-dim">{linkedIssue.identifier}</span> {linkedIssue.title}
          </a>
        </RailSection>
      )}

      {stack && stack.layers.length > 1 && (
        <RailSection title="Stack">
          {stack.layers.map((layer) => (
            <Button
              key={layer.number}
              variant={layer.number === stack.selected ? "secondary" : "ghost"}
              size="sm"
              className="justify-start"
              onClick={() => stack.onSelect(layer.number)}
            >
              #{layer.number}
              {layer.title ? ` ${layer.title}` : ""}
            </Button>
          ))}
        </RailSection>
      )}

      {/* Workflow — collapsed by default; omitted entirely when there's nothing to show. */}
      {workflow && <WorkflowSection {...workflow} />}

      {/* Adversarial review */}
      {renderAdversarialReview()}

      </div>

      {/* Merge box — outside the scroll container, so it's always in reach. */}
      {!readOnly && <div className="flex-none border-t border-hairline bg-panel p-4">
        {getMerged()}
        {!merged && !closed && onClosePr && (
          <div className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
            <Button
              variant="danger"
              className="w-full justify-center"
              disabled={!connected || closing}
              onClick={onClosePr}
            >
              {closing ? "Closing…" : "Close pull request"}
            </Button>
            {closeError && <Callout tone="red">{closeError}</Callout>}
          </div>
        )}
      </div>}
    </div>
  )
}
