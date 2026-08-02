import {
  parsePlanHtml,
  type ExecutionMode,
  type PlanAnnotationAnchor,
  type PlanCommentMessage,
  type Plan,
  type PlanDocument,
  type PlanDraft,
  type PlanParticipant
} from "@jingler/core"
import { ClipboardList } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Button } from "../components/button.js"
import { Markdown } from "../components/markdown.js"
import { PlanCommentLayer } from "../composites/plan-doc/plan-comment-layer.js"
import {
  atLeast,
  useWidthTier,
  WidthTierProvider
} from "../hooks/width-tier.js"
import { cn } from "../lib/cn.js"
import {
  PlanEditor,
  type PlanEditorSyncState
} from "../composites/plan-editor.js"

/**
 * The Plan Review tab is the canonical Notion-style document editor.
 *
 * Canonical documents use the Notion-style editor. Threads created before
 * canonical plan documents existed keep their original Markdown in `plan.raw`;
 * those render as a simple read-only document rather than resurrecting the
 * legacy multi-pane review workspace.
 */
export interface PlanReviewProps {
  /** Legacy transcript projection; never rendered as a review workspace. */
  plan: Plan | null
  document?: PlanDocument | null
  /** Live-only sanitized source; never an editable or approvable revision. */
  streamingDraft?: PlanDraft | null
  draft?: string
  syncState?: PlanEditorSyncState
  syncError?: string | null
  canApprove?: boolean
  /** Live worktree patch used for compact per-file evidence in the plan. */
  patch?: string
  knownFiles?: ReadonlySet<string>
  onOpenFile?: (path: string) => void
  /** One-shot stable stage id requested by the composer progress dock. */
  selectedStepId?: string | null
  /** @deprecated Split panes render the same responsive document editor. */
  compact?: boolean
  /** Called after the requested stage has been scrolled into view. */
  onSelectStep?: (stepId: string) => void
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: () => void
  /** @deprecated Comments are anchored directly inside the document editor. */
  onComment?: (stepId: string, body: string) => void
  onStartDraft?: () => void
  onSendToAgent?: () => void
  onRetryDocument?: () => void
  onStopWorker?: (agentId: string) => void
  onRetryWorker?: (agentId: string) => void
  /**
   * Comment-layer seams (a later stage owns rendering). The plan document is
   * read-only now; these are carried through so the comment layer can consume
   * them without re-plumbing the pane, but nothing here dispatches them yet.
   */
  participants?: ReadonlyArray<PlanParticipant>
  onReplyThread?: (
    annotationId: string,
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  onRetryThread?: (
    annotationId: string,
    message: PlanCommentMessage
  ) => Promise<void> | void
  onSetThreadResolved?: (
    annotationId: string,
    resolved: boolean
  ) => Promise<void> | void
  /** Create a new comment on a step (stageId) or a highlighted span (anchor). */
  onAddComment?: (
    target: { stageId?: string; anchor?: PlanAnnotationAnchor },
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  /** Seam for the page-navigation shell rendered around the document body. */
  pageNav?: ReactNode
}

export function PlanReview(props: PlanReviewProps) {
  return (
    <WidthTierProvider className="flex-col">
      <PlanReviewBody {...props} />
    </WidthTierProvider>
  )
}

function PlanReviewBody(props: PlanReviewProps) {
  // Match the conversation transcript/composer column exactly. The plan used to
  // span the whole pane, which made prose line lengths jump when switching tabs
  // and made the same document feel unrelated to the chat that produced it.
  const gutter = atLeast(useWidthTier(), "mid") ? "px-[30px]" : "px-3"
  const {
    plan,
    document,
    streamingDraft,
    draft,
    syncState = "clean",
    syncError,
    canApprove = true,
    onApprove,
    onResume,
    onRevise,
    onStartDraft,
    onSendToAgent,
    onRetryDocument,
    onStopWorker,
    onRetryWorker,
    selectedStepId,
    onSelectStep,
    patch,
    knownFiles,
    onOpenFile,
    participants,
    onReplyThread,
    onRetryThread,
    onSetThreadResolved,
    onAddComment,
    pageNav
  } = props

  const [container, setContainer] = useState<HTMLElement | null>(null)

  const promotedPlan =
    plan?.structured === true ? parsePlanHtml(plan.raw) : null
  const promotingSource =
    document == null && promotedPlan?.valid === true
      ? promotedPlan.html
      : null
  const transientSource = streamingDraft?.source ?? promotingSource
  const transientState =
    streamingDraft !== null && streamingDraft !== undefined
      ? streamingDraft.phase === "complete"
        ? "validating"
        : "composing"
      : promotingSource !== null
        ? "promoting"
        : undefined

  if (!document && plan && promotingSource === null && transientSource === null) {
    return (
      <div className={cn("min-h-0 min-w-0 flex-1 overflow-auto bg-editor", gutter)}>
        <article
          aria-label="Legacy plan markdown"
          className="mx-auto w-full max-w-[760px] py-10"
        >
          <Markdown>{plan.raw}</Markdown>
        </article>
      </div>
    )
  }

  if (!document && transientSource === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center">
        <ClipboardList className="size-8 text-line-strong" />
        <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
          No plan yet. In <span className="font-semibold text-text">Plan</span> mode, ask the agent
          for a change and it will map out an approach here — or start one yourself and hand it to
          the agent.
        </div>
        {onStartDraft && (
          <Button size="sm" onClick={onStartDraft}>
            <ClipboardList className="size-3.5" />
            Start a plan
          </Button>
        )}
      </div>
    )
  }

  const commentLayer =
    document != null ? (
      <PlanCommentLayer
        annotations={document.projection.annotations}
        participants={participants ?? []}
        containerRef={container}
        onAddComment={onAddComment ?? (() => {})}
        onReply={onReplyThread ?? (() => {})}
        onSetResolved={onSetThreadResolved ?? (() => {})}
        onRetry={onRetryThread}
        disabled={syncState === "saving" || syncState === "conflict"}
      />
    ) : null

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 bg-editor", gutter)}>
      <div
        data-testid="plan-review-container"
        className="mx-auto flex min-h-0 w-full max-w-[980px] flex-1"
      >
        <PlanEditor
          document={document ?? null}
          source={transientSource ?? draft ?? document?.source ?? ""}
          transientState={transientState}
          state={syncState}
          error={syncError}
          canApprove={canApprove}
          onApprove={onApprove}
          onResume={onResume}
          onRevise={onRevise}
          onSendToAgent={onSendToAgent}
          onRetry={onRetryDocument}
          onStopWorker={onStopWorker}
          onRetryWorker={onRetryWorker}
          targetStageId={selectedStepId}
          onTargetStageConsumed={
            selectedStepId ? () => onSelectStep?.(selectedStepId) : undefined
          }
          patch={patch}
          knownFiles={knownFiles}
          onOpenFile={onOpenFile}
          commentLayer={commentLayer}
          onContainerRef={setContainer}
          pageNav={pageNav}
        />
      </div>
    </div>
  )
}
