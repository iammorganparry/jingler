import {
  type PlanCallPathDiff,
  type PlanCallPathFrame,
  type PlanPrd,
  toPlanArchitectureView,
  toPlanStepViews
} from "@jingler/core"
import { ArrowLeft, ArrowRight, GitCompareArrows } from "lucide-react"
import { useMemo } from "react"
import { cn } from "../lib/cn.js"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { PlanBlocks } from "./plan-doc/plan-blocks.js"

export interface PlanGuideProps {
  readonly prd: PlanPrd
  readonly selectedStageId?: string | null
  readonly onOpenStep?: (stageId: string) => void
  readonly className?: string
  readonly revisingStageId?: string | null
}

function CallFrame({ frame }: { frame: PlanCallPathFrame }) {
  return (
    <span className="inline-flex min-w-0 flex-col rounded-md border border-line bg-surface/50 px-2 py-1.5">
      <span className="font-mono text-[11px] font-medium text-text-bright">{frame.symbol}</span>
      {frame.path && (
        <span className="max-w-48 truncate font-mono text-[9.5px] text-muted-foreground">
          {frame.path}
        </span>
      )}
    </span>
  )
}

function CallPath({ label, frames }: { label: string; frames: ReadonlyArray<PlanCallPathFrame> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {frames.map((frame, index) => (
          <div key={`${frame.symbol}-${index}`} className="contents">
            {index > 0 && <ArrowRight className="size-3 flex-none text-dim" />}
            <CallFrame frame={frame} />
          </div>
        ))}
        {frames.length === 0 && <span className="text-[11px] text-dim">No call path</span>}
      </div>
    </div>
  )
}

function CallPathDiff({ diff }: { diff: PlanCallPathDiff }) {
  return (
    <section aria-label="Call path diff" className="flex flex-col gap-3 rounded-md border border-line bg-editor/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-bright">
        <GitCompareArrows className="size-3.5 text-blue" /> Call path change
      </div>
      <CallPath label="Before" frames={diff.before} />
      <CallPath label="After" frames={diff.after} />
    </section>
  )
}

/** Cohesive implementation guide: document context plus stage rationale, call paths, and diagrams. */
export function PlanGuide({ prd, selectedStageId, onOpenStep, className, revisingStageId }: PlanGuideProps) {
  const steps = useMemo(() => toPlanStepViews(prd), [prd])
  const architecture = useMemo(() => toPlanArchitectureView(prd), [prd])
  const diagramsByStage = useMemo(
    () => new Map(architecture.stages.map((stage) => [stage.id, stage.diagrams])),
    [architecture.stages]
  )
  const sections = useMemo(() => {
    const isTldr = (title: string) => title.replace(/[^a-z0-9]/gi, "").toLowerCase() === "tldr"
    return [
      ...architecture.sections.filter((section) => isTldr(section.title)),
      ...architecture.sections.filter((section) => !isTldr(section.title))
    ]
  }, [architecture.sections])

  if (steps.length === 0 && sections.length === 0) {
    return <div className={cn("flex flex-1 items-center justify-center px-4 py-10 text-[13px] text-dim", className)}>No guide yet</div>
  }

  return (
    <article className={cn("flex flex-col gap-4 p-4", className)} aria-label="Plan guide">
      <header className="flex flex-col gap-1 px-1 pb-1">
        <h1 className="m-0 text-[16px] font-semibold text-text-bright">Implementation guide</h1>
        <p className="m-0 max-w-[68ch] text-[12.5px] leading-[1.6] text-muted-foreground">
          Decisions, runtime flow, and intended code shape in implementation order.
        </p>
      </header>

      {sections.map((section) => (
        <section key={section.id} data-plan-section={section.id} className="flex flex-col gap-2 px-1 py-1">
          <h2 className="m-0 text-[13px] font-semibold text-text-bright">{section.title}</h2>
          <PlanBlocks blocks={section.blocks} className="sb-md text-[13px] leading-[1.65] text-text-body" />
        </section>
      ))}

      {steps.map((step, index) => {
        const walkthrough = step.walkthrough ?? []
        const diagrams = diagramsByStage.get(step.id) ?? []
        const selected = step.id === selectedStageId
        return (
          <section
            key={step.id}
            data-stage={step.id}
            data-guide-stage={step.id}
            aria-label={`Guide for ${step.title}`}
            className={cn(
              "relative flex flex-col gap-3 overflow-hidden rounded-lg border bg-panel px-4 py-4 transition-colors",
              selected ? "border-blue/55 bg-blue/[0.06]" : "border-hairline"
            )}
          >
            {step.id === revisingStageId && (
              <div
                role="status"
                aria-label={`Revising ${step.title}`}
                className="absolute inset-0 z-10 flex animate-pulse flex-col justify-center gap-2 bg-panel/90 px-5"
              >
                <span className="text-[11px] font-medium text-blue">Revising this section…</span>
                <span className="h-2 w-5/6 rounded bg-line" />
                <span className="h-2 w-2/3 rounded bg-line" />
                <span className="h-2 w-1/2 rounded bg-line" />
              </div>
            )}
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="m-0 text-[14px] font-semibold leading-[1.4] text-text-bright">{step.title}</h2>
                {step.intent.trim().length > 0 && (
                  <p className="m-0 mt-1 text-[12.5px] leading-[1.6] text-text-body">{step.intent}</p>
                )}
              </div>
              {onOpenStep && (
                <button
                  type="button"
                  aria-label={`Open step ${step.title}`}
                  onClick={() => onOpenStep(step.id)}
                  className="inline-flex flex-none items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-blue outline-none transition-colors hover:border-line-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowLeft className="size-3" /> Step
                </button>
              )}
            </div>

            {(walkthrough.length > 0 || step.approach.length > 0 || step.notes.length > 0) && (
              <div className="flex flex-col gap-3 border-t border-hairline pt-3">
                <PlanBlocks blocks={[...walkthrough, ...step.notes]} className="sb-md text-[12.5px] leading-[1.7] text-text-body" />
                {walkthrough.length === 0 && step.approach.length > 0 && (
                  <ol className="m-0 pl-5 text-[12.5px] leading-[1.7] text-text-body">
                    {step.approach.map((item) => <li key={item}>{item}</li>)}
                  </ol>
                )}
              </div>
            )}

            {step.callPathDiff && <CallPathDiff diff={step.callPathDiff} />}

            {diagrams.map((diagram) => (
              <div key={diagram.id} role="img" aria-label={`Diagram ${diagram.id}`} className="overflow-hidden rounded-md border border-line bg-surface/40 px-3 py-2">
                <MermaidDiagram source={diagram.source} />
              </div>
            ))}
          </section>
        )
      })}
    </article>
  )
}
