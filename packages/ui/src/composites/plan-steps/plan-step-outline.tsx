import { type PlanPrd, toPlanStepViews } from "@jingler/core"
import { useMemo } from "react"
import { PlanStepCard } from "./plan-step-card.js"

/**
 * The **Steps** surface (design screen 04): a plan's steps as a vertical stack of
 * digestible cards, one per stage, in dependency-topological order.
 *
 * It takes the canonical `PlanPrd` and derives its rows with `toPlanStepViews` —
 * the pure `@jingler/core` projection — so no plan-document plumbing leaks into
 * the view. A composing/streaming plan (stages still arriving from the planner)
 * needs no special branch: the projection simply yields the stages that exist so
 * far, and the outline renders those cards, growing as more land. Each projected
 * row carries its durable task status into `PlanStepCard`.
 * Selection is lifted: `selectedStepId` drives the active card and
 * `onSelectStep` reports clicks back up, using the same stage id the Workflow
 * and Guide surfaces key on.
 */
export interface PlanStepOutlineProps {
  readonly prd: PlanPrd
  readonly selectedStepId?: string | null
  readonly onSelectStep?: (stepId: string) => void
  readonly onOpenGuide?: (stepId: string) => void
  readonly revisingStageId?: string | null
}

export function PlanStepOutline({ prd, selectedStepId, onSelectStep, onOpenGuide, revisingStageId }: PlanStepOutlineProps) {
  const steps = useMemo(() => toPlanStepViews(prd), [prd])

  if (steps.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center text-[13px] text-dim">
        No steps yet
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 p-4">
      {steps.map((step) => (
        <PlanStepCard
          key={step.id}
          step={step}
          active={step.id === selectedStepId}
          revising={step.id === revisingStageId}
          onSelect={onSelectStep}
          onOpenGuide={onOpenGuide}
        />
      ))}
    </div>
  )
}
