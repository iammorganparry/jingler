import type { PlanDocument, PlanPrdStage } from "@jingler/core"
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  ClipboardList,
  Loader2,
  PauseCircle,
  XCircle
} from "lucide-react"
import type { ComponentType } from "react"
import { useId, useState } from "react"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"

export type PlanProgressStatus =
  | "todo"
  | "in-progress"
  | "done"
  | "blocked"
  | "failed"
  | "interrupted"

const acceptanceDone = (stage: PlanPrdStage): boolean =>
  stage.acceptance.length > 0 &&
  stage.acceptance.every(
    (criterion) =>
      criterion.status === "passed" || criterion.status === "waived"
  )

/** Project canonical worker state into the compact operator vocabulary. */
export const planProgressStatus = (stage: PlanPrdStage): PlanProgressStatus => {
  if (stage.executionStatus === "completed") return "done"
  switch (stage.executionStatus) {
    case "running":
      return "in-progress"
    case "blocked":
      return "blocked"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
    default:
      return acceptanceDone(stage) ? "done" : "todo"
  }
}

const STATUS: Readonly<
  Record<
    PlanProgressStatus,
    {
      readonly label: string
      readonly className: string
      readonly icon: ComponentType<{ className?: string }>
    }
  >
> = {
  todo: { label: "To do", className: "text-muted", icon: Circle },
  "in-progress": {
    label: "In progress",
    className: "text-blue",
    icon: Loader2
  },
  done: { label: "Done", className: "text-green", icon: CheckCircle2 },
  blocked: { label: "Blocked", className: "text-yellow", icon: CircleAlert },
  failed: { label: "Failed", className: "text-red", icon: XCircle },
  interrupted: {
    label: "Interrupted",
    className: "text-orange",
    icon: PauseCircle
  }
}

/**
 * Composer-adjacent view of the live canonical plan.
 *
 * It owns no progress state: Plan.watch updates the PlanDocument and the
 * orchestration service updates each stage. This component is only a projection,
 * so the plan and the dock cannot become competing sources of truth.
 */
export function PlanProgressDock({
  document,
  onOpenStage,
  className
}: {
  document: PlanDocument
  onOpenStage?: (stageId: string) => void
  className?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const stages = document.plan.stages
  if (stages.length === 0) return null

  const rows = stages.map((stage, index) => ({
    stage,
    number: String(index + 1).padStart(2, "0"),
    status: planProgressStatus(stage)
  }))
  const completed = rows.filter((row) => row.status === "done").length
  const active =
    rows.find((row) => row.status === "in-progress") ??
    rows.find(
      (row) =>
        row.status === "blocked" ||
        row.status === "failed" ||
        row.status === "interrupted"
    ) ??
    rows.find((row) => row.status === "todo") ??
    null
  const summary =
    active === null
      ? "All steps done"
      : `${active.number} ${active.stage.title} · ${STATUS[active.status].label}`
  const progress = Math.round((completed / rows.length) * 100)

  return (
    <section
      data-testid="plan-progress-dock"
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-panel shadow-sm",
        className
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`Plan progress: ${completed} of ${rows.length} done`}
        onClick={() => setExpanded((value) => !value)}
        className="group relative flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ClipboardList className="size-4 shrink-0 text-purple" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <strong className="text-[11.5px] font-semibold text-text-bright">
              Plan progress
            </strong>
            <span className="font-mono text-[10px] tabular-nums text-muted">
              {completed}/{rows.length}
            </span>
          </span>
          <span className="block truncate text-[10.5px] text-muted-foreground">
            {summary}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-dim transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-px bg-line"
        >
          <span
            className="block h-full bg-green transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </span>
      </button>

      {expanded && (
        <div
          id={listId}
          className="max-h-[240px] overflow-y-auto border-t border-line p-1.5"
        >
          {rows.map(({ stage, number, status }) => {
            const config = STATUS[status]
            const Icon = config.icon
            const assignment = stage.assignment
            return (
              <button
                key={stage.id}
                type="button"
                data-testid={`plan-progress-stage-${stage.id}`}
                onClick={() => onOpenStage?.(stage.id)}
                className="group flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    config.className,
                    status === "in-progress" && "animate-spin"
                  )}
                />
                <span className="w-5 shrink-0 font-mono text-[9.5px] tabular-nums text-dim">
                  {number}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[11.5px]",
                      status === "done"
                        ? "text-muted-foreground"
                        : "text-text-body"
                    )}
                  >
                    {stage.title}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[9.5px] text-dim">
                    {assignment ? (
                      <>
                        <ProviderIcon cli={assignment.cli} size={10} />
                        <span className="truncate">
                          {assignment.agentId} · {assignment.model}
                        </span>
                      </>
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[9.5px] font-medium",
                    config.className
                  )}
                >
                  {config.label}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
