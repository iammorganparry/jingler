import { type ReactNode, useState } from "react"
import type {
  PlanAcceptance,
  PlanStageComplexity,
  PlanStageExecutionStatus,
  PlanStepView,
  PlanTask
} from "@jingler/core"
import { PlanBlocks } from "../plan-doc/plan-blocks.js"
import { Check, Circle, MinusCircle, RotateCw, Square, X } from "lucide-react"
import { Badge } from "../../components/badge.js"
import { FileChip } from "../../components/file-chip.js"
import { MermaidDiagram } from "../../components/mermaid-diagram.js"
import { StatusDot } from "../../components/status-dot.js"
import { cn } from "../../lib/cn.js"
import { usePlanFileControls } from "../plan-doc/plan-file-controls.js"
import { usePlanWorkerControls } from "../plan-doc/plan-worker-controls.js"

/** Execution states whose owning worker can be halted / re-run from the card. */
const STOPPABLE: ReadonlySet<PlanStageExecutionStatus> = new Set(["running", "blocked"])
const RETRYABLE: ReadonlySet<PlanStageExecutionStatus> = new Set(["failed", "interrupted"])

/**
 * Step-based outline card (design screen 04). One digestible card per plan step,
 * built entirely from `PlanStepView` — the pure `@jingler/core` projection — so
 * the whole outline is testable without a live plan document.
 *
 * A card carries four scannable sections: **Changes** (declared files), **Tasks**
 * (durable checklist progress plus approach prose), the stage's own
 * **Architecture**, and **Tests** (criteria, evidence, and linked named cases).
 *
 * Selection is the whole card: clicking (or activating with the keyboard) calls
 * `onSelect(step.id)`, and `active` paints the selected state. A stable
 * `data-step-id` lets sibling surfaces (e.g. the Workflow graph) cross-link to a
 * specific card.
 */

/** Planner complexity estimate -> tinted chip tone. */
const COMPLEXITY_TONE: Record<PlanStageComplexity, "blue" | "yellow" | "red"> = {
  low: "blue",
  medium: "yellow",
  high: "red"
}

/** Durable worker state -> a status dot tone + label colour + motion. */
const EXECUTION_META: Record<
  PlanStageExecutionStatus,
  { readonly dot: string; readonly text: string; readonly label: string; readonly pulse?: boolean }
> = {
  queued: { dot: "bg-line-strong", text: "text-dim", label: "Queued" },
  running: { dot: "bg-blue", text: "text-blue", label: "Running", pulse: true },
  blocked: { dot: "bg-yellow", text: "text-yellow", label: "Blocked" },
  failed: { dot: "bg-red", text: "text-red", label: "Failed" },
  interrupted: { dot: "bg-yellow", text: "text-muted-foreground", label: "Interrupted" },
  completed: { dot: "bg-green", text: "text-green", label: "Completed" }
}

/** Acceptance status -> icon + token colour (per Stage 04 spec). */
const ACCEPTANCE_META: Record<
  PlanAcceptance["status"],
  { readonly Icon: typeof Check; readonly text: string; readonly label: string }
> = {
  passed: { Icon: Check, text: "text-green", label: "Passed" },
  failed: { Icon: X, text: "text-red", label: "Failed" },
  pending: { Icon: Circle, text: "text-dim", label: "Pending" },
  waived: { Icon: MinusCircle, text: "text-muted-foreground", label: "Waived" }
}

/** Task progress -> checklist icon + token colour. */
const TASK_META: Record<
  PlanTask["status"],
  { readonly Icon: typeof Check; readonly text: string; readonly label: string }
> = {
  pending: { Icon: Circle, text: "text-dim", label: "Pending" },
  "in-progress": { Icon: RotateCw, text: "text-blue", label: "In progress" },
  completed: { Icon: Check, text: "text-green", label: "Completed" },
  blocked: { Icon: MinusCircle, text: "text-yellow", label: "Blocked" }
}

const CHANGE_BORDER: Record<PlanStepView["files"][number]["change"], string | undefined> = {
  A: "border-green/40",
  M: undefined,
  D: "border-red/40"
}

/**
 * Cap how many file chips a card renders. A stage can touch hundreds of files;
 * beyond this the row becomes noise, so the rest collapse into a "+N more" chip.
 */
const MAX_VISIBLE_FILES = 12

/**
 * Sanitize the stage body and drop blocks that are already surfaced elsewhere on
 * the card: the `<ul data-files>` declaration (rendered as `FileChip`s in the
 * Changes section), the `[data-acceptance]` criteria (the Tests section), the
 * `[data-assignment]` worker metadata, and any embedded mermaid diagrams (an
 * Architecture-surface concern). Mirrors `plan-architecture`'s `sectionProse`.
 */
export interface PlanStepCardProps {
  readonly step: PlanStepView
  /** Renders the selected state and marks the card current. */
  readonly active?: boolean
  /** Fired when the card is clicked or activated with the keyboard. */
  readonly onSelect?: (stepId: string) => void
}

export function PlanStepCard({ step, active, onSelect }: PlanStepCardProps) {
  const tasks = step.tasks ?? []
  const diagrams = step.diagrams ?? []
  const completedTasks = tasks.filter((task) => task.status === "completed").length
  const hasNotes = step.notes.length > 0
  const hasApproach = step.approach.length > 0
  // Live worktree evidence + open handler come from the plan file-controls
  // context (provided around the outline), so chips open the asset and show
  // live +/- while there's uncommitted work — falling back to declared counts.
  const fileControls = usePlanFileControls()
  const workerControls = usePlanWorkerControls()
  const [filesExpanded, setFilesExpanded] = useState(false)
  const exec = EXECUTION_META[step.executionStatus]
  const canStop =
    step.agentId !== null && STOPPABLE.has(step.executionStatus) && workerControls.stop !== undefined
  const canRetry =
    step.agentId !== null && RETRYABLE.has(step.executionStatus) && workerControls.retry !== undefined
  const select = () => {
    // A drag that ends inside the card fires a click too; ignore it so
    // selecting text to comment doesn't also select-and-scroll the card.
    const selection = typeof window === "undefined" ? null : window.getSelection()
    if (selection !== null && !selection.isCollapsed) return
    onSelect?.(step.id)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an outer <button> can't wrap the card's own interactive descendants; role+keyboard handler keep it accessible
    <div
      data-step-id={step.id}
      data-stage={step.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          select()
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-3.5 rounded-lg border bg-panel px-4 py-3.5 text-left",
        "transition-[background-color,border-color] duration-150 ease-out outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-blue/55 bg-blue/[0.06]"
          : "border-hairline hover:border-line-strong hover:bg-surface/50"
      )}
    >
      {/* Header: step id marker + title, complexity chip, execution status */}
      <div className="flex items-start gap-2.5">
        <span className="mt-px flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
          {step.id}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px] font-semibold leading-[1.4]",
            active ? "text-text-bright" : "text-text"
          )}
        >
          {step.title}
        </span>
        {step.complexity && (
          <Badge tone={COMPLEXITY_TONE[step.complexity]} size="xs" className="mt-px flex-none uppercase">
            {step.complexity}
          </Badge>
        )}
        <span className={cn("mt-px flex flex-none items-center gap-1.5 text-[10.5px] font-medium", exec.text)}>
          <StatusDot tone={exec.dot} size={7} pulse={exec.pulse} glow={exec.pulse} />
          {exec.label}
        </span>
      </div>

      {/* Worker assignment — who runs this stage, on what route, and its status.
          Only present once a plan is delegated; a plain plan-mode plan has none. */}
      {step.agentId !== null && (
        <div
          data-plan-assignment-card="true"
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-hairline bg-surface/40 px-2.5 py-1.5 text-[10.5px] leading-none"
        >
          <span className="font-mono font-medium text-text">{step.agentId}</span>
          {step.worker !== null && <span className="text-muted-foreground">{step.worker}</span>}
          {step.reasoningEffort !== null && (
            <span className="text-muted-foreground">Reasoning: {step.reasoningEffort}</span>
          )}
          <span className={cn("ml-auto flex items-center gap-1.5 font-medium", exec.text)}>
            <StatusDot tone={exec.dot} size={6} pulse={exec.pulse} glow={exec.pulse} />
            {exec.label}
          </span>
          {canStop && (
            <button
              type="button"
              aria-label={`Stop worker ${step.agentId}`}
              title="Stop worker"
              className="flex flex-none items-center gap-1 rounded border border-line/70 px-1.5 py-0.5 text-red hover:bg-red/10"
              onClick={(event) => {
                event.stopPropagation()
                if (step.agentId !== null) workerControls.stop?.(step.agentId)
              }}
            >
              <Square className="size-3" />
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              aria-label={`Retry worker ${step.agentId}`}
              title="Retry worker"
              className="flex flex-none items-center gap-1 rounded border border-line/70 px-1.5 py-0.5 text-blue hover:bg-blue/10"
              onClick={(event) => {
                event.stopPropagation()
                if (step.agentId !== null) workerControls.retry?.(step.agentId)
              }}
            >
              <RotateCw className="size-3" />
            </button>
          )}
        </div>
      )}

      {/* Changes */}
      <CardSection title="Changes" count={step.files.length}>
        {step.files.length === 0 ? (
          <EmptyNote>No file changes declared.</EmptyNote>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(filesExpanded ? step.files : step.files.slice(0, MAX_VISIBLE_FILES)).map((file) => {
              const evidence = fileControls.evidence?.get(file.path)
              const openable =
                fileControls.open !== undefined &&
                (fileControls.knownFiles === undefined ||
                  fileControls.knownFiles.has(file.path) ||
                  evidence !== undefined ||
                  (file.added ?? 0) + (file.removed ?? 0) > 0)
              return (
                <FileChip
                  key={`${file.change}-${file.path}`}
                  path={file.path}
                  // Live evidence wins while it exists; declared counts remain
                  // once the work is committed and evidence collapses to 0.
                  added={evidence?.added || file.added || 0}
                  removed={evidence?.removed || file.removed || 0}
                  onOpen={openable ? fileControls.open : undefined}
                  className={CHANGE_BORDER[file.change]}
                />
              )
            })}
            {step.files.length > MAX_VISIBLE_FILES && (
              <button
                type="button"
                aria-expanded={filesExpanded}
                onClick={(event) => {
                  event.stopPropagation()
                  setFilesExpanded((open) => !open)
                }}
                className="inline-flex h-[22px] flex-none items-center rounded-[5px] border border-line/70 bg-surface/40 px-2 font-mono text-[10.5px] text-muted-foreground outline-none transition-colors hover:border-line-strong hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
              >
                {filesExpanded
                  ? "Show less"
                  : `+${step.files.length - MAX_VISIBLE_FILES} more`}
              </button>
            )}
          </div>
        )}
      </CardSection>

      {/* Tasks: intent + approach + prose blocks */}
      <CardSection title="Tasks">
        {tasks.length > 0 && (
          <>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {completedTasks} of {tasks.length} completed
            </span>
            <ol aria-label="Stage tasks" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {tasks.map((task, index) => {
                const meta = TASK_META[task.status]
                const { Icon } = meta
                return (
                  <li key={task.id} className="flex items-start gap-2 text-[12px] leading-[1.5]">
                    <span className="w-4 flex-none font-mono text-[10px] tabular-nums text-dim">
                      {index + 1}.
                    </span>
                    <Icon
                      aria-label={meta.label}
                      className={cn("mt-0.5 size-3.5 flex-none", meta.text)}
                      strokeWidth={2.25}
                    />
                    <span className="min-w-0 flex-1 text-text-body">{task.text}</span>
                    <span
                      className={cn(
                        "flex-none text-[9.5px] font-medium uppercase tracking-wide",
                        meta.text
                      )}
                    >
                      {meta.label}
                    </span>
                  </li>
                )
              })}
            </ol>
          </>
        )}
        {step.intent.trim().length > 0 && (
          <p className="m-0 text-[12.5px] leading-[1.55] text-text-body">{step.intent}</p>
        )}
        {hasApproach && (
          <ol className="m-0 pl-4 text-[12.5px] leading-[1.6] text-text-body">
            {step.approach.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        )}
        {hasNotes && (
          <PlanBlocks blocks={step.notes} className="sb-md text-[12.5px] leading-[1.6] text-text-body" />
        )}
        {tasks.length === 0 && step.intent.trim().length === 0 && !hasApproach && !hasNotes && (
          <EmptyNote>No task detail yet.</EmptyNote>
        )}
      </CardSection>

      {diagrams.length > 0 && (
        <section
          aria-label={`Architecture for ${step.title}`}
          className="flex flex-col gap-1.5"
        >
          <h4 className="m-0 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
            Architecture
          </h4>
          <div className="flex flex-col gap-2">
            {diagrams.map((diagram) => (
              <div
                key={diagram.id}
                role="img"
                aria-label={`Diagram ${diagram.id}`}
                className="overflow-hidden rounded-md border border-line bg-surface/40 px-2 py-1"
              >
                <MermaidDiagram source={diagram.source} className="my-2" />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tests: acceptance criteria */}
      <CardSection title="Tests" count={step.acceptance.length}>
        {step.acceptance.length === 0 ? (
          <EmptyNote>No acceptance criteria yet.</EmptyNote>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {step.acceptance.map((criterion) => {
              const meta = ACCEPTANCE_META[criterion.status]
              const { Icon } = meta
              const testReferences = criterion.testReferences ?? []
              return (
                <li key={criterion.id} className="flex flex-col gap-1.5">
                  <div className="flex items-start gap-2 text-[12px] leading-[1.5]">
                    <Icon className={cn("mt-0.5 size-3.5 flex-none", meta.text)} strokeWidth={2.25} />
                    <span className="min-w-0 flex-1 text-text-body">{criterion.text}</span>
                    <span className={cn("flex-none text-[9.5px] font-medium uppercase tracking-wide", meta.text)}>
                      {meta.label}
                    </span>
                  </div>
                  {criterion.evidence && (
                    <p className="m-0 pl-[22px] text-[11px] leading-[1.5] text-muted-foreground">
                      {criterion.evidence}
                    </p>
                  )}
                  {testReferences.length > 0 && (
                    <div className="flex flex-col gap-1.5 pl-[22px]">
                      {testReferences.map((reference) => {
                        const openable =
                          fileControls.open !== undefined &&
                          (fileControls.knownFiles === undefined ||
                            fileControls.knownFiles.has(reference.path))
                        return (
                          <div
                            key={reference.path}
                            className="flex min-w-0 flex-col items-start gap-1"
                          >
                            <FileChip
                              path={reference.path}
                              onOpen={openable ? fileControls.open : undefined}
                            />
                            {reference.cases.length > 0 && (
                              <ul
                                aria-label={`Named test cases in ${reference.path}`}
                                className="m-0 flex list-none flex-col gap-0.5 p-0 pl-1"
                              >
                                {reference.cases.map((testCase) => (
                                  <li
                                    key={testCase}
                                    className="font-mono text-[10.5px] leading-[1.45] text-muted-foreground"
                                  >
                                    {testCase}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardSection>
    </div>
  )
}

function CardSection({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="m-0 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
        {title}
        {count !== undefined && count > 0 && (
          <span className="font-mono text-[9px] text-dim tabular-nums">{count}</span>
        )}
      </h4>
      {children}
    </section>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[11.5px] text-dim">{children}</p>
}
