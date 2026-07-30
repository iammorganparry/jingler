import type { ExecutionMode, Plan, PlanDocument } from "@jingler/core"
import { ClipboardList } from "lucide-react"
import { Button } from "../components/button.js"
import { Markdown } from "../components/markdown.js"
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
export function PlanReview(props: {
  /** Legacy transcript projection; never rendered as a review workspace. */
  plan: Plan | null
  document?: PlanDocument | null
  draft?: string
  remote?: PlanDocument | null
  syncState?: PlanEditorSyncState
  syncError?: string | null
  canApprove?: boolean
  /** @deprecated Legacy step-review input retained for caller compatibility. */
  patch?: string
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
  onEditDocument?: (source: string) => void
  onSaveDocument?: () => void
  onRetryDocument?: () => void
  onKeepLocal?: () => void
  onAcceptRemote?: () => void
  onStopWorker?: (agentId: string) => void
  onRetryWorker?: (agentId: string) => void
}) {
  const {
    plan,
    document,
    draft,
    remote,
    syncState = "clean",
    syncError,
    canApprove = true,
    onApprove,
    onResume,
    onRevise,
    onStartDraft,
    onSendToAgent,
    onEditDocument,
    onSaveDocument,
    onRetryDocument,
    onKeepLocal,
    onAcceptRemote,
    onStopWorker,
    onRetryWorker,
    selectedStepId,
    onSelectStep
  } = props

  if (!document && plan) {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-editor">
        <article
          aria-label="Legacy plan markdown"
          className="mx-auto w-full max-w-[860px] px-6 py-10 sm:px-10"
        >
          <Markdown>{plan.raw}</Markdown>
        </article>
      </div>
    )
  }

  if (!document) {
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

  return (
    <PlanEditor
      document={document}
      draft={draft ?? document.source}
      remote={remote}
      state={syncState}
      error={syncError}
      canApprove={canApprove}
      onApprove={onApprove}
      onResume={onResume}
      onRevise={onRevise}
      onSendToAgent={onSendToAgent}
      onEdit={onEditDocument}
      onSave={onSaveDocument}
      onRetry={onRetryDocument}
      onKeepLocal={onKeepLocal}
      onAcceptRemote={onAcceptRemote}
      onStopWorker={onStopWorker}
      onRetryWorker={onRetryWorker}
      targetStageId={selectedStepId}
      onTargetStageConsumed={
        selectedStepId ? () => onSelectStep?.(selectedStepId) : undefined
      }
    />
  )
}
