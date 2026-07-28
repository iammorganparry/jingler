import type { PlanAcceptanceStatus, PlanDocument } from "@jingler/core"
import { Markdown } from "./markdown.js"
import { PlanAnnotation } from "../composites/plan-annotation.js"
import { PlanStage } from "../composites/plan-stage.js"

export function PlanMdx({
  document,
  disabled = false,
  onCriterionChange,
  onAnnotate
}: {
  document: PlanDocument
  disabled?: boolean
  onCriterionChange?: (
    criterionId: string,
    status: PlanAcceptanceStatus,
    evidence: string | null
  ) => void
  onAnnotate?: (stageId: string | null, body: string) => void
}) {
  const globalAnnotations = document.projection.annotations.filter(
    (annotation) => annotation.stageId === null
  )

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-5 px-6 py-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-purple">
          Product requirements document
        </p>
        <h1 className="mt-1 text-[24px] font-semibold text-text-bright">
          {document.projection.title}
        </h1>
      </header>

      {document.projection.sections.map((section) => (
        <section key={section.id} className="rounded-xl border border-line bg-panel p-5">
          <h2 className="text-[15px] font-semibold text-text-bright">{section.title}</h2>
          <Markdown className="mt-3 text-[13px]">{section.markdown}</Markdown>
        </section>
      ))}

      {document.projection.stages.map((stage) => (
        <PlanStage
          key={stage.id}
          stage={stage}
          revision={document.revision}
          disabled={disabled}
          annotations={document.projection.annotations.filter(
            (annotation) => annotation.stageId === stage.id
          )}
          onCriterionChange={onCriterionChange}
          onAnnotate={(body) => onAnnotate?.(stage.id, body)}
        />
      ))}

      {globalAnnotations.length > 0 && (
        <section className="space-y-2">
          {globalAnnotations.map((annotation) => (
            <PlanAnnotation key={annotation.id} annotation={annotation} />
          ))}
        </section>
      )}
    </div>
  )
}
