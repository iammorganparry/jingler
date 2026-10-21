import { useEffect, useState } from "react"
import type { AdversarialReview, ReviewFinding, ReviewPhase, ReviewSeverity } from "@jingler/core"
import { adversarialReviewModelLabel } from "@jingler/core"
import { destinationOf, findingLocation, partitionFindings, resolvedCount } from "@jingler/core"
import {
  AlertTriangle,
  ChevronRight,
  CornerDownRight,
  GitCommitHorizontal,
  type LucideIcon,
  MessageSquare
} from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Spinner } from "../components/loading.js"
import { cn } from "../lib/cn.js"
import { CommentRow } from "../components/comment-row.js"
import { fmtElapsed } from "../lib/relative-time.js"

/**
 * What the reviewer is doing right now, in the operator's words.
 *
 * There is no percentage here on purpose: nothing in a review announces a total,
 * so a bar would be a fabricated animation. Naming the actual phase is honest and
 * more useful — a review stuck on "Reading" for two minutes is legible, where a
 * bar at 60% would not be. `done`/`error` never render (the button leaves its
 * running state), but are mapped so the record is total.
 */
const PHASE_LABEL: Record<ReviewPhase, string> = {
  starting: "Starting…",
  reading: "Reading the code…",
  thinking: "Thinking…",
  writing: "Writing findings…",
  done: "Finishing…",
  error: "Failing…"
}

/**
 * What became of a finding — the card's own account of itself.
 *
 * Findings are no longer sent by hand: critical/major go to the session's agent
 * automatically, minor/nit are posted to the PR. So a card's job changed. It
 * used to offer an action; now it reports an outcome, and the only interesting
 * question is which one.
 */
export type FindingOutcome =
  | { readonly kind: "resolved"; readonly sha: string; readonly subject: string }
  | { readonly kind: "routed" } // sent to the agent
  | { readonly kind: "posted" } // posted to the PR
  | { readonly kind: "post-failed"; readonly message: string }
  | { readonly kind: "manual" } // not sent — offer the button

/**
 * Work out a finding's outcome from the review's own stamps.
 *
 * Derived rather than tracked, and that's the point: the in-memory routed-store
 * is empty after a reload, so a card keyed off it alone would show "not sent"
 * for a finding the agent is already fixing. `routedAt`/`postedAt` are persisted
 * with the review, so they survive — and severity says which stamp applies.
 *
 * There is deliberately no "pending / Sending…" outcome. A finding was either
 * acted on (its stamp is set) or it wasn't (offer the button). "In flight" is
 * not a state a card can honestly report: routing/posting happen server-side and
 * the only signal a card sees is the stamp flipping null→set, so a "pending"
 * derived from an absent stamp cannot tell "a moment from settling" apart from
 * "never going to settle" — and the latter (a review persisted before this
 * feature, which nothing backfills) would spin forever. Unstamped always reads
 * as "Send to agent": true, and actionable.
 */
export const outcomeOf = (
  finding: ReviewFinding,
  review: AdversarialReview | null,
  opts: { readonly sent: boolean }
): FindingOutcome => {
  // Outranks every other outcome, including a failed post. How a finding was
  // DELIVERED stops mattering the moment it's fixed — "Couldn't post to PR" on a
  // resolved finding reads as an outstanding problem when there is none.
  if (finding.resolvedBy !== null) {
    return { kind: "resolved", sha: finding.resolvedBy.sha, subject: finding.resolvedBy.subject }
  }
  if (review === null) return opts.sent ? { kind: "routed" } : { kind: "manual" }
  const destination = review.postToPr === false ? "agent" : destinationOf(finding.severity)
  if (destination === "agent") {
    return review.routedAt !== null || opts.sent ? { kind: "routed" } : { kind: "manual" }
  }
  if (opts.sent) return { kind: "routed" }
  if (review.postError !== null) return { kind: "post-failed", message: review.postError }
  if (review.postedAt !== null) return { kind: "posted" }
  return { kind: "manual" }
}

/**
 * The formatted elapsed time since `startedAt`, re-rendering each second while
 * `live`. Returns null when there's nothing to time — so the timer only ticks
 * during a run, and stops dead the moment it ends.
 */
function useTicker(live: boolean, startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live || startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live, startedAt])
  if (!live || startedAt === null) return null
  return fmtElapsed(now - startedAt)
}

/** Sort order for triage — worst first. */
const SEVERITY_RANK: Record<ReviewSeverity, number> = { critical: 0, major: 1, minor: 2, nit: 3 }

/** Findings ranked worst-first; ties keep the reviewer's own order. */
export const rankFindings = (
  findings: readonly ReviewFinding[]
): readonly ReviewFinding[] =>
  [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

/**
 * How each outcome reads. `manual` is absent by construction — it isn't an
 * outcome to report, it's the absence of one, and `OutcomeLine` renders nothing
 * for it.
 */
const OUTCOME_META: Record<
  Exclude<FindingOutcome["kind"], "manual" | "resolved">,
  { Icon: LucideIcon; label: string; tone: string }
> = {
  routed: { Icon: CornerDownRight, label: "Sent to agent", tone: "text-muted-foreground" },
  posted: { Icon: MessageSquare, label: "Posted to PR", tone: "text-dim" },
  "post-failed": { Icon: AlertTriangle, label: "Couldn't post to PR", tone: "text-red" }
}

/** The outcome footer — an icon, a word, and nothing else unless it went wrong. */
function OutcomeLine({ outcome }: { outcome: FindingOutcome }) {
  if (outcome.kind === "manual") return null
  // Resolved carries evidence, so it gets its own line rather than a label: the
  // abbreviated SHA is the pointer to what actually fixed it, and the full
  // subject rides in the tooltip. Attribution is inferred (see `resolveFindings`),
  // so naming the commit is what lets the operator check the claim.
  if (outcome.kind === "resolved") {
    return (
      <div
        className="flex items-center gap-[5px] text-[10.5px] leading-none text-muted-foreground"
        title={`${outcome.sha.slice(0, 7)} — ${outcome.subject}`}
      >
        <GitCommitHorizontal size={11} strokeWidth={2.25} />
        <span>Resolved in</span>
        <span className="font-mono text-muted-foreground">{outcome.sha.slice(0, 7)}</span>
      </div>
    )
  }
  const meta = OUTCOME_META[outcome.kind]
  return (
    <div
      className={cn("flex items-center gap-[5px] text-[10.5px] leading-none", meta.tone)}
      title={outcome.kind === "post-failed" ? outcome.message : undefined}
    >
      <meta.Icon size={10.5} strokeWidth={2.25} />
      <span>{meta.label}</span>
    </div>
  )
}

export interface ReviewFindingRowProps {
  finding: ReviewFinding
  /** Already handed to the agent — the action stays in its terminal state. */
  sent: boolean
  canRoute: boolean
  /** The review this finding belongs to — carries the routed/posted stamps. */
  review?: AdversarialReview | null
  onSendToAgent?: (findingId: string) => void
  /** Shown when this finding is dismissed and revealed again: offers Restore. */
  dismissed?: boolean
  onDismiss?: (findingId: string) => void
  onRestore?: (findingId: string) => void
}

function FindingActions({
  canAsk,
  canRoute,
  onAsk,
  onRestore
}: {
  canAsk: boolean
  canRoute: boolean
  onAsk: () => void
  onRestore?: () => void
}) {
  if (!canAsk && !onRestore) return null
  return (
    <>
      {canAsk && (
        <Button variant="ghost" size="sm" disabled={!canRoute} onClick={onAsk}>
          Ask agent to fix
        </Button>
      )}
      {onRestore && (
        <Button variant="ghost" size="sm" onClick={onRestore}>
          Restore
        </Button>
      )}
    </>
  )
}

/** One finding, as a plain comment row (severity text, message, Ask agent to fix, Dismiss). */
export function ReviewFindingRow({
  finding,
  sent,
  canRoute,
  review = null,
  onSendToAgent,
  dismissed = false,
  onDismiss,
  onRestore
}: ReviewFindingRowProps) {
  const location = findingLocation(finding)
  const outcome = outcomeOf(finding, review, { sent })
  const resolved = outcome.kind === "resolved"
  // Resolved findings collapse to title + outcome; re-openable to check the fix.
  const [expanded, setExpanded] = useState(false)
  const collapsed = resolved && !expanded
  const canAsk = onSendToAgent && outcome.kind !== "routed" && !resolved && !dismissed
  return (
    <div
      data-testid={`finding-${finding.id}`}
      data-resolved={resolved ? "true" : undefined}
      data-dismissed={dismissed ? "true" : undefined}
      className={cn((resolved || dismissed) && "opacity-55 hover:opacity-100")}
    >
      <CommentRow
        severity={finding.severity}
        location={location ?? undefined}
        onDismiss={!dismissed && onDismiss ? () => onDismiss(finding.id) : undefined}
        action={
          <FindingActions
            canAsk={!!canAsk}
            canRoute={canRoute}
            onAsk={() => onSendToAgent?.(finding.id)}
            onRestore={dismissed && onRestore ? () => onRestore(finding.id) : undefined}
          />
        }
      >
        <div className="flex flex-col gap-[7px]">
          {resolved ? (
            <Button
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="h-auto w-full justify-start gap-[5px] p-0 text-left text-[12.5px] font-semibold leading-[1.35] text-muted-foreground line-through decoration-dim"
            >
              <ChevronRight
                size={12}
                aria-hidden
                className={cn("flex-none no-underline transition-transform", expanded && "rotate-90")}
              />
              <span className="min-w-0 flex-1">{finding.title}</span>
            </Button>
          ) : (
            <span className="font-semibold">{finding.title}</span>
          )}
          {!collapsed && (
            <>
              <p className="text-[11.5px] leading-[1.5] text-text">{finding.rationale}</p>
              {finding.suggestion !== null && (
                <p className="border-l border-line py-[2px] pl-[7px] text-[11px] leading-[1.45] text-muted-foreground">
                  {finding.suggestion}
                </p>
              )}
            </>
          )}
          <OutcomeLine outcome={outcome} />
        </div>
      </CommentRow>
    </div>
  )
}

export interface FindingsListProps {
  findings: readonly ReviewFinding[]
  review: AdversarialReview | null
  sentFindingIds?: ReadonlySet<string>
  canRoute: boolean
  onSendFindingToAgent?: (findingId: string) => void
  dismissedFindingIds?: ReadonlySet<string>
  /** Dismiss (`dismissed` true) or restore (false) a finding. */
  onDismissFinding?: (findingId: string, dismissed?: boolean) => void
}

/** Findings minus the dismissed ones, plus a "Dismissed (N) · Show" row that reveals them again. */
export function FindingsList({
  findings,
  review,
  sentFindingIds,
  canRoute,
  onSendFindingToAgent,
  dismissedFindingIds,
  onDismissFinding
}: FindingsListProps) {
  const [showDismissed, setShowDismissed] = useState(false)
  const dismissed = findings.filter((f) => dismissedFindingIds?.has(f.id))
  const active = findings.filter((f) => !dismissedFindingIds?.has(f.id))
  const row = (finding: ReviewFinding, isDismissed: boolean) => (
    <ReviewFindingRow
      key={finding.id}
      finding={finding}
      sent={sentFindingIds?.has(finding.id) ?? false}
      canRoute={canRoute}
      review={review}
      onSendToAgent={onSendFindingToAgent}
      dismissed={isDismissed}
      onDismiss={onDismissFinding ? (id) => onDismissFinding(id, true) : undefined}
      onRestore={onDismissFinding ? (id) => onDismissFinding(id, false) : undefined}
    />
  )
  return (
    <div className="flex flex-col">
      {active.map((f) => row(f, false))}
      {dismissed.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          aria-expanded={showDismissed}
          onClick={() => setShowDismissed((v) => !v)}
        >
          {`Dismissed (${dismissed.length}) · ${showDismissed ? "Hide" : "Show"}`}
        </Button>
      )}
      {showDismissed && dismissed.map((f) => row(f, true))}
    </div>
  )
}

export interface ReviewFindingsProps {
  review: AdversarialReview | null
  /** A reviewer run is in flight. */
  running: boolean
  /** Where the running reviewer has got to (ignored unless `running`). */
  phase?: ReviewPhase
  /** Epoch ms the run started, or null — drives the button's live timer. */
  startedAt?: number | null
  /** The message from a failed run, or null. */
  error?: string | null
  /** GitHub is connected and the session has a PR — the run action is available. */
  canRun: boolean
  /** The session can receive a routed finding (has a live conversation). */
  canRoute?: boolean
  onRun?: () => void
  onSendFindingToAgent?: (findingId: string) => void
  /** Ids of findings already sent to the agent — their action stays "Sent". */
  sentFindingIds?: ReadonlySet<string>
  dismissedFindingIds?: ReadonlySet<string>
  onDismissFinding?: (findingId: string, dismissed?: boolean) => void
}

/**
 * The adversarial review panel: the run action, and the findings it produced.
 *
 * Presentational — the caller owns the RPC and the routing. Rendered in the PR
 * right rail; the same rows are reused inline in the Code Review view.
 */
export function ReviewFindings({
  review,
  running,
  phase = "starting",
  startedAt = null,
  error,
  canRun,
  canRoute = true,
  onRun,
  onSendFindingToAgent,
  sentFindingIds,
  dismissedFindingIds,
  onDismissFinding
}: ReviewFindingsProps) {
         function renderReviewButton() {
           return (<Button
        variant="secondary"
        className="w-full justify-center gap-2"
        disabled={!canRun || running || !onRun}
        onClick={onRun}
      >
        {running && <Spinner size={13} />}
        {running ? (
          <>
            <span>{PHASE_LABEL[phase]}</span>
            {/* Tabular numerals so a ticking timer doesn't jiggle the label. */}
            {elapsed && <span className="text-dim tabular-nums">{elapsed}</span>}
          </>
        ) : review === null ? (
          "Adversarial review"
        ) : (
          "Review again"
        )}
      </Button>)
         }

         function renderFindingSummary() {
           return (split !== null && findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-[7px] gap-y-1 text-[11px] text-muted-foreground">
          {split.toAgent.length > 0 && (
            <span className="flex items-center gap-[5px]">
              <CornerDownRight size={11} strokeWidth={2.25} className="text-muted-foreground" />
              <span className="tabular-nums text-text">{split.toAgent.length}</span>
              <span>to the agent</span>
            </span>
          )}
          {split.toAgent.length > 0 && split.toPr.length > 0 && <span className="text-dim">·</span>}
          {split.toPr.length > 0 && (
            <span className="flex items-center gap-[5px]">
              <MessageSquare size={11} strokeWidth={2.25} className="text-blue" />
              <span className="tabular-nums text-text">{split.toPr.length}</span>
              <span>on the PR</span>
            </span>
          )}
          {/*
            Progress, not just distribution. Once the agent starts landing fixes
            this is the number the operator is actually tracking — how much of the
            review is still outstanding — and without it the summary keeps
            describing the review as it was dispatched, never as it stands.
          */}
          {resolved > 0 && (
            <>
              <span className="text-dim">·</span>
              <span className="flex items-center gap-[5px]">
                <GitCommitHorizontal size={12} strokeWidth={2.25} className="text-muted-foreground" />
                <span className="tabular-nums text-text">{resolved}</span>
                <span>resolved</span>
              </span>
            </>
          )}
        </div>
      ))
         }

  const findings = review === null ? [] : rankFindings(review.findings)
  const elapsed = useTicker(running && startedAt !== null, startedAt)
  const split = review === null
    ? null
    : review.postToPr === false
      ? { toAgent: review.findings, toPr: [] }
      : partitionFindings(review.findings)
  const resolved = review === null ? 0 : resolvedCount(review.findings)

  return (
    <div className="flex flex-col gap-3">
      {renderReviewButton()}

      {error && (
        <Callout tone="red" className="items-start">
          {error}
        </Callout>
      )}

      {/* The reviewer ran but said something we couldn't parse — a refusal, or
          prose. Showing its words beats an empty list that reads as "no bugs". */}
      {review?.note != null && (
        <Callout tone="blue" className="items-start">
          {review.note}
        </Callout>
      )}

      {review !== null && findings.length === 0 && review.note == null && (
        <Callout tone="blue">
          The reviewer argued against this diff and found nothing to report.
        </Callout>
      )}

      {/*
        What the review DID, in one line, above the evidence.
        Routing and posting now happen without anyone asking, so the first thing
        a reader needs is not the findings — it's to know the agent already has
        the serious ones. Without this the automation is invisible and the list
        reads like a to-do list you're expected to work through by hand.
      */}
      {renderFindingSummary()}

      {/* The post failed — say so once, here, rather than only on each nit's
          card. The cause is the review's, not any one finding's. */}
      {review?.postError != null && (
        <Callout tone="red" className="items-start">
          {review.postError}
        </Callout>
      )}

      {findings.length > 0 && (
        <FindingsList
          findings={findings}
          review={review}
          sentFindingIds={sentFindingIds}
          canRoute={canRoute}
          onSendFindingToAgent={onSendFindingToAgent}
          dismissedFindingIds={dismissedFindingIds}
          onDismissFinding={onDismissFinding}
        />
      )}

      {review !== null && (
        <span className="font-mono text-[10px] text-dim">
          {adversarialReviewModelLabel(review)} · {review.headSha.slice(0, 7)}
        </span>
      )}
    </div>
  )
}
