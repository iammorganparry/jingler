import {
  parsePlanHtml,
  type PlanPrd,
  type ExecutionMode,
  type PlanDocument
} from "@jingler/core"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { parseUnifiedDiff } from "../diff/parse.js"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import {
  PlanDocView,
  type PlanFileEvidence
} from "./plan-doc/plan-doc-view.js"
import { PlanFileControlsProvider } from "./plan-doc/plan-file-controls.js"
import { PlanArchitecture } from "./plan-architecture.js"
import { PlanFloatingActions } from "./plan-floating-actions.js"
import { PlanStepOutline } from "./plan-steps/plan-step-outline.js"
import { PlanWorkflow } from "./plan-workflow.js"

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

/** The three plan surfaces the operator can switch between. */
export type PlanPage = "main" | "architecture" | "workflow"

const PLAN_PAGES: ReadonlyArray<{ value: PlanPage; label: string }> = [
  { value: "main", label: "Main" },
  { value: "architecture", label: "Architecture" },
  { value: "workflow", label: "Workflow" }
]

export interface PlanEditorProps {
  document: PlanDocument | null
  /** The sanitized plan source HTML to render read-only. */
  source: string
  /** A read-only source that has not yet joined the canonical revision stream. */
  transientState?: PlanEditorTransientState
  state: PlanEditorSyncState
  error?: string | null
  canApprove?: boolean
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: () => void
  onSendToAgent?: () => void
  /** Reload the document after a load failure. */
  onRetry?: () => void
  onStopWorker?: (agentId: string) => void
  onRetryWorker?: (agentId: string) => void
  /** One-shot stable stage id requested by the composer progress dock. */
  targetStageId?: string | null
  onTargetStageConsumed?: () => void
  patch?: string
  knownFiles?: ReadonlySet<string>
  onOpenFile?: (path: string) => void
  /**
   * The comment overlay (built by the screen from the plan's annotations). It is
   * rendered above the Main step outline and positions itself off the outline's
   * scroll container, handed back through `onContainerRef`.
   */
  commentLayer?: ReactNode
  /** Receives the live scroll element of the Main page so the comment layer can anchor to it. */
  onContainerRef?: (el: HTMLElement | null) => void
  /** Extra chrome rendered under the page switcher (currently unused seam). */
  pageNav?: ReactNode
}

/**
 * The plan workspace body. The agent's canonical plan is presented across three
 * pages, switched with a segmented control:
 *
 * - **Main** — a step-based outline (`PlanStepOutline`): one digestible card per
 *   stage with its changes, tasks and tests. While the plan is still streaming
 *   (or its HTML hasn't parsed to a projection yet) this falls back to the raw
 *   read-only document (`PlanDocView`) so composing plans still render live.
 * - **Architecture** — prose sections + flow diagrams (`PlanArchitecture`).
 * - **Workflow** — the dependency DAG on a react-flow canvas (`PlanWorkflow`);
 *   selecting a node jumps to Main with that step highlighted.
 *
 * The operator approves / resumes / revises through `PlanFloatingActions`; they
 * no longer edit the prose in place. Comments overlay the Main page.
 */
export function PlanEditor({
  document: doc,
  source,
  transientState,
  state,
  error,
  canApprove = true,
  onApprove,
  onResume,
  onRevise,
  onSendToAgent,
  onRetry,
  onStopWorker,
  onRetryWorker,
  targetStageId,
  onTargetStageConsumed,
  patch = "",
  knownFiles,
  onOpenFile,
  commentLayer,
  onContainerRef,
  pageNav
}: PlanEditorProps) {
  const [page, setPage] = useState<PlanPage>("main")
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const widthTier = useWidthTier()
  const streaming = transientState !== undefined
  const parsed = useMemo(() => parsePlanHtml(source), [source])
  const projection: PlanPrd | null =
    parsed.valid ? parsed.projection : doc?.projection ?? null
  const showOutline = !streaming && projection !== null

  const fileEvidence = useMemo<ReadonlyMap<string, PlanFileEvidence>>(
    () =>
      new Map(
        parseUnifiedDiff(patch)
          .filter((row) => row.kind === "file")
          .map((row) => [
            row.path,
            {
              change:
                row.status === "added"
                  ? "A"
                  : row.status === "deleted"
                    ? "D"
                    : row.status === "renamed"
                      ? "R"
                      : "M",
              added: row.additions,
              removed: row.deletions
            }
          ])
      ),
    [patch]
  )

  // A stage requested by the composer progress dock lands on Main, selected.
  // Defer until the step outline is actually showing — while a plan is still
  // streaming there's no card to select or scroll to, so consuming the target
  // there would silently drop the deep link. It re-fires once the outline mounts.
  useEffect(() => {
    if (targetStageId == null || !showOutline) return
    setPage("main")
    setSelectedStepId(targetStageId)
    onTargetStageConsumed?.()
  }, [targetStageId, showOutline, onTargetStageConsumed])

  // Scroll the selected card into view when it changes (e.g. from a Workflow node click).
  useEffect(() => {
    if (page !== "main" || selectedStepId == null) return
    const el = bodyRef.current?.querySelector(`[data-step-id="${selectedStepId}"]`)
    el?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [page, selectedStepId, showOutline])

  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node
      onContainerRef?.(node)
    },
    [onContainerRef]
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {transientState === undefined && state === "error" && error && (
        <div role="alert" className="flex-none border-b border-red/30 bg-red/5 px-4 py-2 text-[11px] text-red">
          {error}
        </div>
      )}
      <div
        role="tablist"
        className="sb-no-scrollbar flex h-8 flex-none items-center gap-0.5 overflow-x-auto border-b border-hairline bg-editor px-2"
      >
        {PLAN_PAGES.map((item) => {
          const active = item.value === page
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPage(item.value)}
              className={cn(
                "group flex flex-none items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] outline-none transition-colors",
                active
                  ? "bg-panel text-text-bright"
                  : "text-muted-foreground hover:bg-panel/60 hover:text-text"
              )}
            >
              <span className="whitespace-nowrap font-medium">{item.label}</span>
            </button>
          )
        })}
      </div>
      {pageNav}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-editor">
        {page === "main" && (
          <div ref={setContainer} className="relative min-h-0 min-w-0 flex-1 overflow-auto pb-14">
            {showOutline ? (
              <PlanFileControlsProvider
                evidence={fileEvidence}
                knownFiles={knownFiles}
                open={onOpenFile}
              >
                <div className="mx-auto w-full max-w-[760px]">
                  <PlanStepOutline
                    prd={projection}
                    selectedStepId={selectedStepId}
                    onSelectStep={setSelectedStepId}
                  />
                </div>
              </PlanFileControlsProvider>
            ) : (
              <PlanDocView
                className="mx-auto h-full w-full max-w-[760px]"
                source={source}
                fileEvidence={fileEvidence}
                knownFiles={knownFiles}
                onOpenFile={onOpenFile}
                workerControls={
                  streaming ? undefined : { stop: onStopWorker, retry: onRetryWorker }
                }
              />
            )}
            {!streaming && commentLayer}
          </div>
        )}
        {page === "architecture" && (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto pb-14">
            {projection ? (
              <PlanArchitecture prd={projection} className="mx-auto w-full max-w-[760px]" />
            ) : (
              <EmptyPage>No architecture notes yet.</EmptyPage>
            )}
          </div>
        )}
        {page === "workflow" && (
          <div className="min-h-0 min-w-0 flex-1">
            {projection ? (
              <PlanWorkflow
                prd={projection}
                selectedStageId={selectedStepId}
                onSelectStage={(stageId) => {
                  setSelectedStepId(stageId)
                  setPage("main")
                }}
                onStopWorker={onStopWorker}
                onRetryWorker={onRetryWorker}
              />
            ) : (
              <EmptyPage>No workflow yet.</EmptyPage>
            )}
          </div>
        )}
      </div>
      <PlanFloatingActions
        status={doc?.status}
        revision={doc?.revision}
        syncState={state}
        transientState={transientState}
        canApprove={canApprove}
        compact={!atLeast(widthTier, "mid")}
        onApprove={onApprove}
        onResume={onResume}
        onRevise={onRevise}
        onSendToAgent={onSendToAgent}
        onRetry={onRetry}
      />
    </div>
  )
}

function EmptyPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-[13px] text-dim">
      {children}
    </div>
  )
}
