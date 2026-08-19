import type { ExecutionMode, Plan, PlanDocument, PlanTaskStatus } from "@jingler/core"
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDashed,
  CornerDownLeft,
  Download,
  ListChecks,
  ListTodo,
  Loader2,
  Maximize2,
  MoreHorizontal
} from "lucide-react"
import { useState } from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { cn } from "../lib/cn.js"

const WIDTH = "w-full"
const PREVIEW_STEPS = 3

const comparableText = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

const planDescription = (plan: Plan): string | null =>
  plan.raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) =>
      line.length > 0 &&
      !line.startsWith("#") &&
      comparableText(line) !== comparableText(plan.summary)
    ) ?? null

const downloadPlan = (plan: Plan) => {
  const url = URL.createObjectURL(new Blob([plan.raw], { type: "text/markdown" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `${plan.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "plan"}.md`
  link.click()
  URL.revokeObjectURL(url)
}

type ApprovalStage = {
  id: string
  title: string
  tasks: ReadonlyArray<{ id: string; text: string; status: PlanTaskStatus }>
}

const approvalStages = (plan: Plan, document?: PlanDocument | null): ReadonlyArray<ApprovalStage> =>
  document?.id === plan.id
    ? document.plan.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        tasks: stage.tasks ?? []
      }))
    : plan.steps
        .filter((step) => step.kind !== "branch-arm")
        .map((step) => ({ id: step.id, title: step.title, tasks: [] }))

function TaskStatusIcon({ status }: { status: PlanTaskStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-3 shrink-0 text-green" />
    case "in-progress":
      return <Loader2 className="size-3 shrink-0 animate-spin text-blue" />
    case "blocked":
      return <CircleAlert className="size-3 shrink-0 text-yellow" />
    case "pending":
      return <Circle className="size-3 shrink-0 text-dim" />
  }
}

/**
 * Plan-specific approval card, following AI CSS's plan variant while using
 * Jingler's theme tokens and canonical plan callbacks.
 */
export function PlanApprovalCard({
  plan,
  document,
  onApprove,
  onResume,
  onOpenReview,
  className
}: {
  plan: Plan
  /** Canonical stage/task shape for the active plan; legacy transcript cards omit it. */
  document?: PlanDocument | null
  onApprove?: (executionMode?: ExecutionMode) => void
  /** Approve a STALE plan (its original run is gone) — re-drives execution. */
  onResume?: () => void
  /** Open the full Plan Review view (step drill-in, comments, revise). */
  onOpenReview?: () => void
  className?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const pending = plan.status === "proposed" || plan.status === "revising"
  const stale = plan.status === "stale"
  const stages = approvalStages(plan, document)
  const visibleStages = showAll ? stages : stages.slice(0, PREVIEW_STEPS)
  const remaining = Math.max(0, stages.length - PREVIEW_STEPS)
  const description = planDescription(plan)

  return (
    <section
      data-testid="plan-approval-card"
      className={cn(WIDTH, "overflow-hidden rounded-xl border border-line bg-panel shadow-sm", className)}
    >
      <header className="flex min-h-11 items-center gap-2.5 px-3.5 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-purple/10 text-purple">
          {plan.status === "approved" ? <CheckCircle2 className="size-3.5" /> : <ListTodo className="size-3.5" />}
        </span>
        <strong className="min-w-0 flex-1 text-[12px] font-semibold text-text-bright">Plan Overview</strong>
        {plan.status === "approved" && <Badge tone="green" size="xs">Approved</Badge>}
        {plan.status === "rejected" && <Badge tone="neutral" size="xs">Rejected</Badge>}
        {stale && <Badge tone="neutral" size="xs">Stale</Badge>}
        <button
          type="button"
          aria-label="Download plan"
          onClick={() => downloadPlan(plan)}
          className="grid size-7 place-items-center rounded-md text-dim outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="size-3.5" />
        </button>
        {onOpenReview && (
          <button
            type="button"
            aria-label="Expand plan"
            onClick={onOpenReview}
            className="grid size-7 place-items-center rounded-md text-dim outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="size-3.5" />
          </button>
        )}
      </header>

      <div className="px-3.5 pb-3.5 pt-3">
        <div className="mb-3">
          <h3 className="m-0 text-[14px] font-semibold leading-tight text-text-bright">{plan.summary}</h3>
          {description && (
            <p className="mb-0 mt-1 text-[11.5px] leading-[1.5] text-muted-foreground">{description}</p>
          )}
        </div>

        <div className="overflow-hidden rounded-lg bg-sunken/70">
          <div className="flex min-h-9 items-center gap-2 px-3">
            <ListChecks className="size-3.5 text-muted-foreground" />
            <strong className="text-[11px] font-semibold text-text-body">To-dos</strong>
            <span className="rounded-full bg-surface px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {stages.length}
            </span>
          </div>
          <ol className="m-0 flex list-none flex-col gap-1 px-2 py-1.5">
            {visibleStages.map((stage) => (
              <li key={stage.id} className="rounded-md px-1.5 py-1">
                <div className="flex min-h-6 min-w-0 items-center gap-2 text-[11.5px] text-text-body">
                  <CircleDashed className="size-3.5 shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate font-medium">{stage.title}</span>
                </div>
                {stage.tasks.length > 0 && (
                  <ul className="m-0 ml-[21px] mt-0.5 flex list-none flex-col gap-0.5 py-0.5">
                    {stage.tasks.map((task) => (
                      <li key={task.id} className="flex min-h-5 min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                        <TaskStatusIcon status={task.status} />
                        <span className={cn("min-w-0 flex-1 truncate", task.status === "completed" && "line-through decoration-line-strong")}>
                          {task.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>

        {remaining > 0 && (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[10.5px] text-muted-foreground outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-3.5" />
            {showAll ? "Show fewer" : `${remaining} more`}
          </button>
        )}
      </div>

      <footer className="flex min-h-12 flex-wrap items-center gap-2 bg-sunken/60 px-3.5 py-2.5">
        <span className="flex-1" />
        {onOpenReview && (
          <Button variant="ghost" size="sm" onClick={onOpenReview}>View Plan</Button>
        )}
        {pending && (
          <Button size="sm" disabled={onApprove === undefined} onClick={() => onApprove?.()}>
            Approve
            <CornerDownLeft className="size-3" />
          </Button>
        )}
        {stale && onResume && <Button size="sm" onClick={onResume}>Approve &amp; implement</Button>}
      </footer>
    </section>
  )
}

/** @deprecated Use PlanApprovalCard. */
export const PlanCard = PlanApprovalCard
