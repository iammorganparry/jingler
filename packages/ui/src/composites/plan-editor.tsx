import {
  parsePlanHtml,
  type PlanPrd,
  type ExecutionMode,
  type PlanCommentMessage,
  type PlanDocument,
  type PlanParticipant
} from "@jingler/core"
import { AlertTriangle } from "lucide-react"
import { useMemo, useState } from "react"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import {
  PlanDocEditor,
  type PlanDocOutlineEntry,
  type PlanDocViewport
} from "./plan-doc/plan-doc-editor.js"
import { PlanFloatingActions } from "./plan-floating-actions.js"
import { PlanMinimap, type PlanMinimapItem } from "./plan-minimap.js"

export type PlanEditorSyncState =
  | "loading"
  | "clean"
  | "editing"
  | "saving"
  | "conflict"
  | "error"

export type PlanEditorTransientState =
  | "composing"
  | "validating"
  | "promoting"

/**
 * The plan workspace body: one Notion-style Tiptap document. The whole plan —
 * prose, stages, acceptance criteria, annotations, flow diagrams — is edited in
 * place; edits serialize to sanitized HTML and flow out through `onEdit`, which
 * the sync machine debounces and compare-and-swaps. A remote revision arriving
 * mid-edit surfaces the conflict banner (local editable vs remote read-only).
 */
export function PlanEditor({
  document: _document,
  draft,
  transientState,
  remote,
  state,
  error,
  canApprove = true,
  onApprove,
  onResume,
  onRevise,
  onSendToAgent,
  onEdit,
  onSave,
  onRetry,
  onKeepLocal,
  onAcceptRemote,
  onStopWorker,
  onRetryWorker,
  participants = [],
  onReplyThread,
  onRetryThread,
  onSetThreadResolved,
  targetStageId,
  onTargetStageConsumed
}: {
  document: PlanDocument | null
  draft: string
  /** A read-only source that has not yet joined the canonical revision stream. */
  transientState?: PlanEditorTransientState
  remote?: PlanDocument | null
  state: PlanEditorSyncState
  error?: string | null
  canApprove?: boolean
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: () => void
  onSendToAgent?: () => void
  onEdit?: (source: string) => void
  onSave?: () => void
  onRetry?: () => void
  onKeepLocal?: () => void
  onAcceptRemote?: () => void
  onStopWorker?: (agentId: string) => void
  onRetryWorker?: (agentId: string) => void
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
  targetStageId?: string | null
  onTargetStageConsumed?: () => void
}) {
  const [outline, setOutline] = useState<ReadonlyArray<PlanDocOutlineEntry>>([])
  const [viewport, setViewport] = useState<PlanDocViewport>({
    activeId: null,
    start: 0,
    size: 1
  })
  const [targetBlockId, setTargetBlockId] = useState<string | null>(null)
  const widthTier = useWidthTier()
  const showMinimap = atLeast(widthTier, "wide")
  const parsed = useMemo(() => parsePlanHtml(draft), [draft])
  const projection: PlanPrd | null =
    parsed.valid ? parsed.projection : _document?.projection ?? null
  const minimapItems = useMemo<ReadonlyArray<PlanMinimapItem>>(
    () =>
      outline.map((entry) => {
        const stageId = entry.kind === "stage" ? entry.id.slice("stage:".length) : null
        const stage =
          stageId === null
            ? undefined
            : projection?.stages.find((candidate) => candidate.id === stageId)
        const openComments =
          (entry.kind === "section"
            ? 0
            : projection?.annotations.filter(
            (annotation) =>
              annotation.status === "open" &&
              (stageId === null
                ? annotation.stageId === null
                : annotation.stageId === stageId)
              ).length) ?? 0
        return {
          ...entry,
          openComments,
          ...(stage?.executionStatus
            ? { executionStatus: stage.executionStatus }
            : {})
        }
      }),
    [outline, projection]
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {transientState === undefined && state === "conflict" && remote ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-red/30 bg-red/5 px-4 py-3">
            <AlertTriangle className="size-4 text-red" />
            <p className="min-w-0 flex-1 text-[11.5px] text-text-body">
              Revision {remote.revision} arrived while this draft had local edits. Both versions are preserved.
            </p>
            <span className="text-[10px] text-muted-foreground">
              Choose a resolution from the floating actions below.
            </span>
          </div>
          <div className="grid min-h-0 flex-1 divide-x divide-line lg:grid-cols-2">
            <section className="flex min-h-0 flex-col overflow-auto">
              <p className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-yellow">
                Local draft
              </p>
              <PlanDocEditor
                value={draft}
                onChange={onEdit}
                targetStageId={targetStageId}
                onTargetStageConsumed={onTargetStageConsumed}
                workerControls={{
                  stop: onStopWorker,
                  retry: onRetryWorker
                }}
                commentControls={{
                  participants,
                  disabled: true,
                  onReply: onReplyThread,
                  onRetry: onRetryThread,
                  onSetResolved: onSetThreadResolved
                }}
              />
            </section>
            <section className="flex min-h-0 flex-col overflow-auto">
              <p className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue">
                Remote revision {remote.revision}
              </p>
              <PlanDocEditor value={remote.source} editable={false} />
            </section>
          </div>
        </div>
      ) : (
        <>
          {transientState === undefined && state === "error" && error && (
            <div role="alert" className="flex-none border-b border-red/30 bg-red/5 px-4 py-2 text-[11px] text-red">
              {error}
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-editor">
            <div className="min-h-0 min-w-0 flex-1 pb-14">
              <PlanDocEditor
                className="mx-auto h-full w-full max-w-[760px]"
                value={draft}
                editable={transientState === undefined}
                onChange={transientState === undefined ? onEdit : undefined}
                targetStageId={targetStageId}
                onTargetStageConsumed={onTargetStageConsumed}
                targetBlockId={targetBlockId}
                onTargetBlockConsumed={() => setTargetBlockId(null)}
                onOutlineChange={setOutline}
                onViewportChange={setViewport}
                workerControls={
                  transientState === undefined
                    ? {
                        stop: onStopWorker,
                        retry: onRetryWorker
                      }
                    : undefined
                }
                commentControls={
                  transientState === undefined
                    ? {
                        participants,
                        disabled: state !== "clean",
                        onReply: onReplyThread,
                        onRetry: onRetryThread,
                        onSetResolved: onSetThreadResolved
                      }
                    : undefined
                }
              />
            </div>
            {showMinimap && (
              <PlanMinimap
                items={minimapItems}
                activeId={viewport.activeId}
                viewport={viewport}
                onSelect={setTargetBlockId}
              />
            )}
          </div>
        </>
      )}
      <PlanFloatingActions
        status={_document?.status}
        revision={_document?.revision}
        syncState={state}
        transientState={transientState}
        canApprove={canApprove}
        compact={!atLeast(widthTier, "mid")}
        onApprove={onApprove}
        onResume={onResume}
        onRevise={onRevise}
        onSendToAgent={onSendToAgent}
        onSave={onSave}
        onRetry={onRetry}
        onKeepLocal={onKeepLocal}
        onAcceptRemote={onAcceptRemote}
      />
    </div>
  )
}
