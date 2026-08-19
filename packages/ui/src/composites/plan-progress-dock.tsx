import type { PlanDocument, PlanPrdStage } from "@jingler/core"
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
  "in-progress": { label: "In progress", className: "text-blue", icon: Loader2 },
  done: { label: "Done", className: "text-green", icon: CheckCircle2 },
  blocked: { label: "Blocked", className: "text-yellow", icon: CircleAlert },
  failed: { label: "Failed", className: "text-red", icon: XCircle },
  interrupted: { label: "Interrupted", className: "text-orange", icon: PauseCircle }
}

/**
 * Collapsible task-list projection of the live canonical plan. It owns only its
 * open state; stage/task status continues to come exclusively from PlanDocument.
 */
export function PlanTaskList({
  document,
  onOpenStage,
  className
}: {
  document: PlanDocument
  onOpenStage?: (stageId: string) => void
  className?: string
}) {
  const [expanded, setExpanded] = useState(true)
  const listId = useId()
  const stages = document.plan.stages
  if (stages.length === 0) return null

  const rows = stages.map((stage) => ({ stage, status: planProgressStatus(stage) }))
  const completed = rows.filter((row) => row.status === "done").length
  const allDone = completed === rows.length
  const progress = Math.round((completed / rows.length) * 100)

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
          {rows.map(({ stage, status }) => {
            const config = STATUS[status]
            const Icon = config.icon
            return (
              <li key={stage.id}>
                <button
                  type="button"
                  data-testid={`plan-progress-stage-${stage.id}`}
                  onClick={() => onOpenStage?.(stage.id)}
                  className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon
                    aria-hidden="true"
                    className={cn("size-3.5 shrink-0", config.className, status === "in-progress" && "animate-spin")}
                  />
                  <span className={cn(
                    "min-w-0 flex-1 truncate text-[11.5px]",
                    status === "done" ? "text-muted-foreground line-through decoration-line-strong" : "text-text-body"
                  )}>
                    {stage.title}
                  </span>
                  <span className={cn("shrink-0 text-[9.5px] font-medium", config.className)}>{config.label}</span>
                </button>
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
