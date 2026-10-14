import { Button } from "../components/button.js"
import { Spin } from "../components/spin.js"
import { StatusRow } from "../components/status-row.js"
import type { PlanDocument, PlanPrdStage, PlanTaskStatus } from "@jingler/core"
import { planStageExecutionStatus } from "@jingler/core"
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  ListChecks,
  Loader2,
  PauseCircle,
  XCircle
} from "lucide-react"
import type { ComponentType } from "react"
import { useId, useState } from "react"
import { cn } from "../lib/cn.js"

export type PlanProgressStatus = "todo" | "in-progress" | "done" | "blocked" | "failed" | "interrupted"

/** Project canonical single-agent task/evidence state into compact UI status. */
export const planProgressStatus = (stage: PlanPrdStage): PlanProgressStatus => {
  switch (planStageExecutionStatus(stage)) {
    case "queued": return "todo"
    case "running": return "in-progress"
    case "completed": return "done"
    case "blocked": return "blocked"
    case "failed": return "failed"
    case "interrupted": return "interrupted"
  }
}

const STATUS: Readonly<Record<PlanProgressStatus, {
  readonly label: string
  readonly className: string
  readonly icon: ComponentType<{ className?: string }>
}>> = {
  todo: { label: "Pending", className: "text-dim", icon: Circle },
  "in-progress": { label: "In progress", className: "text-text-bright", icon: Loader2 },
  done: { label: "Done", className: "text-muted-foreground", icon: CheckCircle2 },
  blocked: { label: "Blocked", className: "text-muted-foreground", icon: CircleAlert },
  failed: { label: "Failed", className: "text-state-failed", icon: XCircle },
  interrupted: { label: "Interrupted", className: "text-muted-foreground", icon: PauseCircle }
}

export type PlanStageAction = "retry" | "ask" | "resume"
export type PlanStageActionHandler = (action: PlanStageAction, stage: { id: string; step: number; title: string }) => void

/** The chat message each stage action sends — the agent already owns plan execution, so no new RPC. */
export const planStageActionMessage = (action: PlanStageAction, stage: { step: number; title: string }): string => {
  const step = `step ${stage.step} ("${stage.title}")`
  switch (action) {
    case "retry": return `Retry ${step} of the plan.`
    case "ask": return `Why did ${step} of the plan stop? Explain what happened and how we should proceed.`
    case "resume": return `Resume the plan from ${step}.`
  }
}

/** Drawn under a failed / interrupted / blocked row; buttons only when the host wires `onStageAction`. */
function StageStatusLine({ status, step, stageId, title, onStageAction }: {
  status: PlanProgressStatus
  step: number
  stageId: string
  title: string
  onStageAction?: PlanStageActionHandler
}) {
  if (status !== "failed" && status !== "interrupted" && status !== "blocked") return null
  const actions: ReadonlyArray<readonly [PlanStageAction, string]> =
    status === "failed" ? [["retry", "Retry step"], ["ask", "Ask agent"]]
    : status === "interrupted" ? [["resume", "Resume"]]
    : [["ask", "Ask agent"]]
  return (
    <div data-testid={`plan-progress-status-${stageId}`} className="ml-[22px] flex min-h-7 items-center gap-2 pb-1">
      <StatusRow failed={status === "failed"} className="flex-1 text-[10.5px]">
        {status === "failed" ? `Step ${step} failed` : status === "interrupted" ? "Stopped by you" : `Step ${step} blocked`}
      </StatusRow>
      {onStageAction && actions.map(([action, label]) => (
        <Button key={action} variant="ghost" size="sm" onClick={() => onStageAction(action, { id: stageId, step, title })}>{label}</Button>
      ))}
    </div>
  )
}

/** Route a stage action to a chat send; undefined when the host cannot send. */
export const sendPlanStageAction = (onSend?: (text: string) => void): PlanStageActionHandler | undefined =>
  onSend && ((action, stage) => onSend(planStageActionMessage(action, stage)))

/** One flat plan row: neutral icon + title + status label, with the failed / stopped / blocked line beneath. */
export function PlanProgressRow({ status, step, stage, onOpenStage, onStageAction }: {
  status: PlanProgressStatus
  step: number
  stage: { id: string; title: string }
  onOpenStage?: (stageId: string) => void
  onStageAction?: PlanStageActionHandler
}) {
  const config = STATUS[status]
  const Icon = config.icon
  return (
    <>
      <button
        type="button"
        data-testid={`plan-progress-stage-${stage.id}`}
        data-status={status}
        onClick={() => onOpenStage?.(stage.id)}
        className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Spin active={status === "in-progress"} className="shrink-0">
          <Icon aria-hidden="true" className={cn("size-3.5", config.className)} />
        </Spin>
        <span className={cn(
          "min-w-0 flex-1 truncate text-[11.5px]",
          status === "done" ? "text-muted-foreground line-through decoration-line-strong" : "text-text-body"
        )}>
          {stage.title}
        </span>
        <span className={cn("shrink-0 text-[9.5px] font-medium", config.className)}>{config.label}</span>
      </button>
      <StageStatusLine status={status} step={step} stageId={stage.id} title={stage.title} onStageAction={onStageAction} />
    </>
  )
}

/** Per-subtask status icon for the extended (overview) drawer view. */
const TASK_STATUS: Readonly<Record<PlanTaskStatus, {
  readonly className: string
  readonly icon: ComponentType<{ className?: string }>
}>> = {
  pending: { className: "text-dim", icon: Circle },
  "in-progress": { className: "text-text-bright", icon: Loader2 },
  completed: { className: "text-muted-foreground", icon: CheckCircle2 },
  blocked: { className: "text-muted-foreground", icon: CircleAlert }
}

/**
 * Collapsible task-list projection of the live canonical plan. It owns only its
 * open state; stage/task status continues to come exclusively from PlanDocument.
 */
/** Completed / total task counts for the plan — used by the composer tab badge. */
export const planTaskCounts = (
  document: PlanDocument
): { readonly completed: number; readonly total: number } => {
  const stages = document.plan.stages
  return {
    completed: stages.filter((stage) => planProgressStatus(stage) === "done").length,
    total: stages.length
  }
}

export function PlanTaskList({
  document,
  onOpenStage,
  className,
  bare = false,
  overview = false,
  onStageAction
}: {
  document: PlanDocument
  onOpenStage?: (stageId: string) => void
  className?: string
  /** Render only the task rows — no header, no collapse. For the tabbed drawer. */
  bare?: boolean
  /** The extended drawer view: stages with their nested subtasks (the plan overview). */
  overview?: boolean
  /** Retry / Ask agent / Resume on failed, interrupted and blocked rows. */
  onStageAction?: PlanStageActionHandler
}) {
  const [expanded, setExpanded] = useState(true)
  const listId = useId()
  const stages = document.plan.stages
  if (stages.length === 0) return null

  const rows = stages.map((stage) => ({ stage, status: planProgressStatus(stage) }))
  const completed = rows.filter((row) => row.status === "done").length
  const allDone = completed === rows.length
  const progress = Math.round((completed / rows.length) * 100)

  const list = (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
      {rows.map(({ stage, status }, index) => {
        const config = STATUS[status]
        const Icon = config.icon
        return (
          <li key={stage.id}>
            <PlanProgressRow status={status} step={index + 1} stage={stage} onOpenStage={onOpenStage} onStageAction={onStageAction} />
          </li>
        )
      })}
    </ol>
  )

  const overviewList = (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map(({ stage, status }, index) => {
        const config = STATUS[status]
        const StageIcon = config.icon
        const tasks = stage.tasks ?? []
        return (
          <li key={stage.id}>
            <button
              type="button"
              data-testid={`plan-progress-stage-${stage.id}`}
              onClick={() => onOpenStage?.(stage.id)}
              className="group flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Spin active={status === "in-progress"} className="shrink-0"><StageIcon aria-hidden="true" className={cn("size-3.5", config.className)} /></Spin>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text-body">{stage.title}</span>
            </button>
            <StageStatusLine status={status} step={index + 1} stageId={stage.id} title={stage.title} onStageAction={onStageAction} />
            {tasks.length > 0 && (
              <ul className="m-0 ml-[22px] flex list-none flex-col gap-0.5 py-0.5">
                {tasks.map((task) => {
                  const ts = TASK_STATUS[task.status]
                  const TaskIcon = ts.icon
                  return (
                    <li key={task.id} className="flex min-h-5 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      <Spin active={task.status === "in-progress"} className="shrink-0"><TaskIcon aria-hidden="true" className={cn("size-3", ts.className)} /></Spin>
                      <span className={cn("min-w-0 flex-1 truncate", task.status === "completed" && "line-through decoration-line-strong")}>{task.text}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )

  if (bare) {
    return (
      <div data-testid="plan-task-list" className={cn("max-h-[280px] overflow-y-auto px-2 py-1.5", className)}>
        {overview ? overviewList : list}
      </div>
    )
  }

  return (
    <section
      data-testid="plan-task-list"
      className={cn("overflow-hidden rounded-xl border border-line bg-panel", className)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`Plan tasks: ${completed} of ${rows.length} done`}
        onClick={() => setExpanded((value) => !value)}
        className="group flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="relative grid size-5 shrink-0 place-items-center text-purple">
          {allDone ? (
            <CheckCircle2 className="size-4 text-green" />
          ) : completed > 0 ? (
            <svg aria-hidden="true" className="size-4 -rotate-90" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.18" />
              <circle
                cx="10"
                cy="10"
                r="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                pathLength="100"
                strokeDasharray={`${progress} 100`}
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <ListChecks className="size-4" />
          )}
        </span>
        <strong className="text-[11.5px] font-semibold text-text-bright">Plan tasks</strong>
        <span className="font-mono text-[10px] tabular-nums text-muted">{completed}/{rows.length}</span>
        <span className="flex-1" />
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-dim transition-transform duration-200", expanded && "rotate-180")}
        />
      </button>

      <div
        id={listId}
        hidden={!expanded}
        className="max-h-[240px] overflow-y-auto border-t border-line px-2 py-1.5"
      >
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
          {rows.map(({ stage, status }, index) => {
            const config = STATUS[status]
            const Icon = config.icon
            return (
              <li key={stage.id}>
                <PlanProgressRow status={status} step={index + 1} stage={stage} onOpenStage={onOpenStage} onStageAction={onStageAction} />
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

/** @deprecated Use PlanTaskList. */
export const PlanProgressDock = PlanTaskList
