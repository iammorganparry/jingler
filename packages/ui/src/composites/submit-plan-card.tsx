import type { ToolCall } from "@jingler/core"
import { CircleDashed, ListTodo, Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { cn } from "../lib/cn.js"

/** The Jingler plan-submission control tool this card owns the rendering of. */
export const SUBMIT_PLAN_TOOL = "jingler_submit_plan"

const PREVIEW_STEPS = 3

/**
 * What this card needs from the submitted plan — deliberately NOT the full
 * `Plan` shape. The source is a tool's `output` string: untrusted, produced by
 * `JSON.stringify` on the runner's decision, and CAPPED upstream (a large plan
 * arrives truncated mid-JSON). Narrowing to the fields actually rendered means
 * one defensive extraction instead of trusting a whole nested structure.
 */
export interface SubmittedPlanPreview {
  readonly id: string
  readonly summary: string
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string }>
}

/** The operator-relevant reading of a settled `jingler_submit_plan` result. */
export type SubmitPlanDecision =
  | {
      readonly kind: "approved"
      /** Execution mode the run continues under, when the decision carried one. */
      readonly mode: string | null
      readonly plan: SubmittedPlanPreview | null
    }
  | { readonly kind: "revise" }
  | { readonly kind: "rejected" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const planPreview = (value: unknown): SubmittedPlanPreview | null => {
  if (!isRecord(value)) return null
  const { id, summary, steps } = value
  if (typeof id !== "string" || typeof summary !== "string") return null
  const previewSteps = Array.isArray(steps)
    ? steps.flatMap((step) =>
        isRecord(step) &&
        typeof step.id === "string" &&
        typeof step.title === "string" &&
        step.kind !== "branch-arm"
          ? [{ id: step.id, title: step.title }]
          : []
      )
    : []
  return { id, summary, steps: previewSteps }
}

/**
 * The head of a capped output still carries `"summary":"…"` intact (the plan's
 * scalar fields serialize first), so a truncated decision can at least name the
 * plan it applied. The escaped-string round-trip through `JSON.parse` keeps
 * this from mangling summaries with quotes in them.
 */
const SUMMARY_FIELD = /"summary"\s*:\s*("(?:[^"\\]|\\.)*")/

const summaryFromTruncated = (output: string): string | null => {
  const match = SUMMARY_FIELD.exec(output)
  if (match === null) return null
  try {
    const summary: unknown = JSON.parse(match[1]!)
    return typeof summary === "string" && summary.length > 0 ? summary : null
  } catch {
    return null
  }
}

/**
 * Decode a settled submit-plan tool output into the decision it recorded, or
 * null when the output holds no readable decision (still running, truncated
 * past parseability, or a shape this version doesn't know).
 */
export const decodeSubmitPlanDecision = (
  output: string | undefined
): SubmitPlanDecision | null => {
  if (output === undefined || output.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  switch (parsed._tag) {
    case "Approve":
      return {
        kind: "approved",
        mode: typeof parsed.mode === "string" ? parsed.mode : null,
        plan: planPreview(parsed.plan)
      }
    case "Revise":
      return { kind: "revise" }
    case "Reject":
      return { kind: "rejected" }
    default:
      return null
  }
}

const OUTCOME = {
  approved: { label: "Approved", tone: "green" },
  revise: { label: "Revision requested", tone: "yellow" },
  rejected: { label: "Rejected", tone: "neutral" }
} as const

function StepPreview({ steps }: { steps: ReadonlyArray<{ id: string; title: string }> }) {
  const visible = steps.slice(0, PREVIEW_STEPS)
  const remaining = steps.length - visible.length
  if (visible.length === 0) return null
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1 rounded-lg bg-sunken/70 px-3 py-2">
      {visible.map((step) => (
        <li
          key={step.id}
          className="flex min-h-6 min-w-0 items-center gap-2 text-[11.5px] text-text-body"
        >
          <CircleDashed className="size-3.5 shrink-0 text-dim" />
          <span className="min-w-0 flex-1 truncate font-medium">{step.title}</span>
        </li>
      ))}
      {remaining > 0 && (
        <li className="min-h-5 pl-[22px] text-[10.5px] text-muted-foreground">
          +{remaining} more {remaining === 1 ? "step" : "steps"}
        </li>
      )}
    </ul>
  )
}

function DiscardButton({ onDiscard }: { onDiscard: () => void }) {
  // Discard is destructive, so the button arms on the first click and only
  // fires on the second — the same contract as Plan Review's floating action.
  const [confirming, setConfirming] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-red hover:text-red"
      onClick={() => {
        if (confirming) {
          setConfirming(false)
          onDiscard()
        } else {
          setConfirming(true)
        }
      }}
    >
      <Trash2 className="size-3" />
      {confirming ? "Click again to discard" : "Discard plan"}
    </Button>
  )
}

/**
 * The transcript's own rendering of a `jingler_submit_plan` tool call — the
 * generic tool card printed the decision's raw JSON, which is not a thing an
 * operator can read, let alone act on.
 *
 * The card is deliberately quieter than `PlanApprovalCard`: when a submission
 * is gated, that card (in the same turn) owns approval, and `message-turn`
 * suppresses this one entirely. What renders here is the case with no plan
 * card in the turn — above all an auto-applied mid-execution amendment — so
 * the job is "show what was submitted, open the full plan, or discard it".
 */
export function SubmitPlanCard({
  tool,
  decision,
  onOpenPlanReview,
  onDiscardPlan,
  className
}: {
  tool: ToolCall
  /** Pre-decoded by the caller (it also drives suppression there). */
  decision: SubmitPlanDecision | null
  /** Open the full Plan Review view. */
  onOpenPlanReview?: () => void
  /** Discard the session's canonical plan (same action as Plan Review's). */
  onDiscardPlan?: () => void
  className?: string
}) {
  if (tool.status === "running") {
    return (
      <div
        data-testid="submit-plan-card"
        className={cn(
          "flex w-fit items-center gap-2 rounded-full border border-line bg-sunken px-3 py-1.5 text-[12px] text-muted-foreground",
          className
        )}
      >
        <Loader2 className="size-3.5 animate-spin text-purple" />
        Submitting plan…
      </div>
    )
  }
  return (
    <SettledSubmitPlanCard
      tool={tool}
      decision={decision}
      onOpenPlanReview={onOpenPlanReview}
      onDiscardPlan={onDiscardPlan}
      className={className}
    />
  )
}

function SubmitPlanHeader({
  mode,
  failed,
  outcome
}: {
  mode: string | null
  failed: boolean
  outcome: (typeof OUTCOME)[keyof typeof OUTCOME] | null
}) {
  return (
    <header className="flex min-h-11 items-center gap-2.5 px-3.5 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-purple/10 text-purple">
        <ListTodo className="size-3.5" />
      </span>
      <strong className="min-w-0 flex-1 text-[12px] font-semibold text-text-bright">
        Plan submitted
      </strong>
      {mode !== null && (
        <Badge tone="neutral" size="xs" title="Execution mode">{mode}</Badge>
      )}
      {failed && <Badge tone="red" size="xs">Failed</Badge>}
      {outcome && <Badge tone={outcome.tone} size="xs">{outcome.label}</Badge>}
    </header>
  )
}

function SettledSubmitPlanCard({
  tool,
  decision,
  onOpenPlanReview,
  onDiscardPlan,
  className
}: {
  tool: ToolCall
  decision: SubmitPlanDecision | null
  onOpenPlanReview?: () => void
  onDiscardPlan?: () => void
  className?: string
}) {
  const failed = tool.status === "error"
  const outcome = failed ? null : decision === null ? OUTCOME.approved : OUTCOME[decision.kind]
  const plan = decision?.kind === "approved" ? decision.plan : null
  const summary = plan?.summary ?? summaryFromTruncated(tool.output ?? "")
  const mode = decision?.kind === "approved" ? decision.mode : null
  const discardable = !failed && decision?.kind !== "rejected" && onDiscardPlan !== undefined

  return (
    <section
      data-testid="submit-plan-card"
      className={cn("w-full overflow-hidden rounded-xl border border-line bg-panel shadow-sm", className)}
    >
      <SubmitPlanHeader mode={mode} failed={failed} outcome={outcome} />

      {summary !== null && (
        <div className="px-3.5 pb-3.5">
          <h3 className="m-0 text-[14px] font-semibold leading-tight text-text-bright">{summary}</h3>
          {plan !== null && <StepPreview steps={plan.steps} />}
        </div>
      )}

      {(onOpenPlanReview !== undefined || discardable) && (
        <footer className="flex min-h-12 flex-wrap items-center gap-2 bg-sunken/60 px-3.5 py-2.5">
          <span className="flex-1" />
          {discardable && onDiscardPlan !== undefined && <DiscardButton onDiscard={onDiscardPlan} />}
          {onOpenPlanReview !== undefined && (
            <Button variant="ghost" size="sm" onClick={onOpenPlanReview}>View plan</Button>
          )}
        </footer>
      )}
    </section>
  )
}
