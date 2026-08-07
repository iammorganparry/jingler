import { type PlanBlock, type PlanPrd, toPlanArchitectureView } from "@jingler/core"
import { useMemo } from "react"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { PlanBlocks } from "./plan-doc/plan-blocks.js"
import { cn } from "../lib/cn.js"

/**
 * The **Architecture** surface: a read-only render of a plan's prose sections
 * (TL;DR first, then Context / Goals / Technical design / Decisions) and every
 * embedded mermaid flow diagram grouped by its owning stage.
 *
 * The component takes the canonical `PlanPrd` and derives its view with
 * `toPlanArchitectureView` — the pure `@jingler/core` projection that returns
 * the verbatim prose `sections` plus stage-owned diagram groups. Keeping the
 * projection in core (not here) means ownership is testable without React.
 *
 * ## Read-only
 *
 * There is no editor here — section bodies use the typed `PlanBlock` renderer.
 * Diagrams render through `MermaidDiagram` (strict mode, DOMPurify'd SVG).
 *
 * Section-owned diagrams remain in their section block flow. Stage diagrams are
 * rendered separately under a heading and jump link carrying the same stage id
 * as the Steps card.
 */

function ArchitectureSection({
  title,
  blocks
}: {
  title: string
  blocks: ReadonlyArray<PlanBlock>
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-text-bright">{title}</h2>
      <PlanBlocks blocks={blocks} className="sb-md text-[13px] leading-[1.65] text-text-body" />
    </section>
  )
}

/**
 * Read-only Architecture view for a plan. Pass the canonical `PlanPrd`; the
 * component derives its own `PlanArchitectureView` via `toPlanArchitectureView`.
 */
export function PlanArchitecture({
  prd,
  className,
  onOpenStage
}: {
  prd: PlanPrd
  className?: string
  onOpenStage?: (stageId: string) => void
}) {
  const view = useMemo(() => toPlanArchitectureView(prd), [prd])
  const sections = useMemo(() => {
    const isTldr = (title: string) => title.replace(/[^a-z0-9]/gi, "").toLowerCase() === "tldr"
    return [
      ...view.sections.filter((section) => isTldr(section.title)),
      ...view.sections.filter((section) => !isTldr(section.title))
    ]
  }, [view.sections])
  const isEmpty = sections.length === 0 && view.stages.length === 0

  if (isEmpty) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center px-4 py-10 text-center text-[13px] text-dim",
          className
        )}
      >
        No architecture notes yet
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-6 p-4", className)}>
      {sections.map((section) => (
        <ArchitectureSection key={section.id} title={section.title} blocks={section.blocks} />
      ))}

      {view.stages.map((stage) => (
        <section
          key={stage.id}
          aria-label={`Architecture for ${stage.title}`}
          data-stage-architecture={stage.id}
          className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel px-4 py-3.5"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {stage.id}
            </span>
            <h2 className="min-w-0 flex-1 text-[13px] font-semibold text-text-bright">
              {stage.title}
            </h2>
            {onOpenStage && (
              <button
                type="button"
                aria-label={`Open stage ${stage.title} in Steps`}
                onClick={() => onOpenStage(stage.id)}
                className="flex-none rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-blue outline-none transition-colors hover:border-line-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open in Steps
              </button>
            )}
          </div>
          <div className="flex flex-col gap-3">
            {stage.diagrams.map((diagram) => (
              <div
                key={diagram.id}
                role="img"
                aria-label={`Diagram ${diagram.id}`}
                className="overflow-hidden rounded-md border border-line bg-surface/40 px-3 py-2"
              >
                <MermaidDiagram source={diagram.source} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
