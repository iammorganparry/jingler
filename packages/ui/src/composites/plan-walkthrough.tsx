import { type PlanPrd, toPlanStepViews } from "@jingler/core"
import { ArrowLeft } from "lucide-react"
import { useMemo } from "react"
import { cn } from "../lib/cn.js"
import { PlanBlocks } from "./plan-doc/plan-blocks.js"

export interface PlanWalkthroughProps {
  readonly prd: PlanPrd
  readonly selectedStageId?: string | null
  readonly onOpenStep?: (stageId: string) => void
  readonly className?: string
}

/**
 * Tutorial-style projection of the canonical plan. Every section keeps its
 * stage id and block ids so step links, text-quote comments, and worker prompts
 * all refer to the same durable content.
 */
export function PlanWalkthrough({
  prd,
  selectedStageId,
  onOpenStep,
  className
}: PlanWalkthroughProps) {
  const steps = useMemo(() => toPlanStepViews(prd), [prd])

  if (steps.length === 0) {
    return (
      <div className={cn("flex flex-1 items-center justify-center px-4 py-10 text-[13px] text-dim", className)}>
        No walkthrough yet
      </div>
    )
  }

  return (
    <article className={cn("flex flex-col gap-4 p-4", className)} aria-label="Plan walkthrough">
      <header className="flex flex-col gap-1 px-1 pb-1">
        <h1 className="m-0 text-[16px] font-semibold text-text-bright">Implementation walkthrough</h1>
        <p className="m-0 max-w-[68ch] text-[12.5px] leading-[1.6] text-muted-foreground">
          Follow each step in order to understand the decisions, rationale, and intended code shape before implementation.
        </p>
      </header>

      {steps.map((step, index) => {
        const selected = step.id === selectedStageId
        const walkthrough = step.walkthrough ?? []
        return (
          <section
            key={step.id}
            data-stage={step.id}
            data-walkthrough-step={step.id}
            aria-label={`Walkthrough for ${step.title}`}
            className={cn(
              "flex flex-col gap-3 rounded-lg border bg-panel px-4 py-4 transition-colors",
              selected ? "border-blue/55 bg-blue/[0.06]" : "border-hairline"
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-[14px] font-semibold leading-[1.4] text-text-bright">
                  {step.title}
                </h2>
                {step.intent.trim().length > 0 && (
                  <p className="m-0 mt-1 text-[12.5px] leading-[1.6] text-text-body">{step.intent}</p>
                )}
              </div>
              {onOpenStep && (
                <button
                  type="button"
                  aria-label={`Open step ${step.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenStep(step.id)
                  }}
                  className="inline-flex flex-none items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-blue outline-none transition-colors hover:border-line-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowLeft className="size-3" /> Step
                </button>
              )}
            </div>

            {(walkthrough.length > 0 || step.approach.length > 0) ? (
              <div className="flex flex-col gap-3 border-t border-hairline pt-3">
                <PlanBlocks
                  blocks={walkthrough}
                  className="sb-md text-[12.5px] leading-[1.7] text-text-body"
                />
                {walkthrough.length === 0 && step.approach.length > 0 && (
                  <ol className="m-0 pl-5 text-[12.5px] leading-[1.7] text-text-body">
                    {step.approach.map((item) => <li key={item}>{item}</li>)}
                  </ol>
                )}
              </div>
            ) : (
              <p className="m-0 border-t border-hairline pt-3 text-[12px] leading-[1.6] text-dim">
                This legacy step has no authored walkthrough yet. Comment here to ask the agent to add one.
              </p>
            )}
          </section>
        )
      })}
    </article>
  )
}
