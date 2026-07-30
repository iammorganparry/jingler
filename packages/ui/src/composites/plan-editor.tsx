import type { ExecutionMode, PlanDocument } from "@jingler/core"
import { AlertTriangle, Check, Cloud, Play, RefreshCw, Save, Send, WifiOff } from "lucide-react"
import { Button } from "../components/button.js"
import { Pill } from "../components/pill.js"
import { cn } from "../lib/cn.js"
import { PlanApprovalActions } from "./plan-approval-actions.js"
import { PlanDocEditor } from "./plan-doc/plan-doc-editor.js"

export type PlanEditorSyncState =
  | "loading"
  | "clean"
  | "editing"
  | "saving"
  | "conflict"
  | "error"

const SYNC: Record<
  PlanEditorSyncState,
  { readonly label: string; readonly className: string; readonly icon: typeof Cloud }
> = {
  loading: { label: "Loading", className: "text-muted-foreground", icon: RefreshCw },
  clean: { label: "Synced", className: "text-green", icon: Check },
  editing: { label: "Editing", className: "text-yellow", icon: Cloud },
  saving: { label: "Saving", className: "text-blue", icon: RefreshCw },
  conflict: { label: "Conflict", className: "text-red", icon: AlertTriangle },
  error: { label: "Save failed", className: "text-red", icon: WifiOff }
}

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
  targetStageId,
  onTargetStageConsumed
}: {
  document: PlanDocument
  draft: string
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
  targetStageId?: string | null
  onTargetStageConsumed?: () => void
}) {
  const sync = SYNC[state]
  const SyncIcon = sync.icon
  const settled =
    _document.status === "approved" ||
    _document.status === "executing" ||
    _document.status === "needs-verification" ||
    _document.status === "done" ||
    _document.status === "rejected"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-hairline bg-panel px-3 py-2">
        <Pill
          tone={
            _document.status === "done" || _document.status === "approved"
              ? "green"
              : _document.status === "needs-verification"
                ? "yellow"
                : "blue"
          }
          pulse={_document.status === "executing"}
        >
          {_document.status.replace("-", " ")}
        </Pill>
        <span className="font-mono text-[10px] text-muted-foreground">
          revision {_document.revision}
        </span>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[10.5px] font-medium",
            sync.className
          )}
        >
          <SyncIcon className={cn("size-3.5", state === "saving" && "animate-spin")} />
          {sync.label}
        </span>
        {_document.status === "draft" ? (
          <Button size="sm" onClick={onSendToAgent}>
            <Send className="size-3.5" />
            Send to agent
          </Button>
        ) : _document.status === "stale" ? (
          <Button size="sm" disabled={!canApprove} onClick={onResume}>
            <Play className="size-3.5" />
            Approve &amp; implement
          </Button>
        ) : settled ? (
          <span className="text-[11px] text-muted-foreground">
            {_document.status === "done" ? "All criteria verified" : _document.status}
          </span>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onRevise}>
              <Send className="size-3.5" />
              Revise with agent
            </Button>
            <PlanApprovalActions onApprove={onApprove} disabled={!canApprove} />
          </>
        )}
        {(state === "editing" || state === "error") && (
          <Button
            variant="secondary"
            size="sm"
            onClick={state === "error" ? onRetry : onSave}
          >
            {state === "error" ? <RefreshCw className="size-3.5" /> : <Save className="size-3.5" />}
            {state === "error" ? "Retry" : "Save now"}
          </Button>
        )}
      </div>

      {state === "conflict" && remote ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-red/30 bg-red/5 px-4 py-3">
            <AlertTriangle className="size-4 text-red" />
            <p className="min-w-0 flex-1 text-[11.5px] text-text-body">
              Revision {remote.revision} arrived while this draft had local edits. Both versions are preserved.
            </p>
            <Button variant="secondary" size="sm" onClick={onAcceptRemote}>Use remote</Button>
            <Button size="sm" onClick={onKeepLocal}>Keep local and save</Button>
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
          {state === "error" && error && (
            <div role="alert" className="flex-none border-b border-red/30 bg-red/5 px-4 py-2 text-[11px] text-red">
              {error}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto bg-editor">
            <PlanDocEditor
              value={draft}
              onChange={onEdit}
              targetStageId={targetStageId}
              onTargetStageConsumed={onTargetStageConsumed}
              workerControls={{
                stop: onStopWorker,
                retry: onRetryWorker
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
