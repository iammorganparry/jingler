import type {
  PlanAcceptanceStatus,
  PlanAnnotation as PlanAnnotationModel,
  PlanPrdStage
} from "@jingler/core"
import { MessageSquarePlus } from "lucide-react"
import { useState } from "react"
import { Button } from "../components/button.js"
import { Markdown } from "../components/markdown.js"
import { PlanAcceptance } from "./plan-acceptance.js"
import { PlanAnnotation } from "./plan-annotation.js"

export function PlanStage({
  stage,
  annotations,
  revision,
  disabled = false,
  onCriterionChange,
  onAnnotate
}: {
  stage: PlanPrdStage
  annotations: ReadonlyArray<PlanAnnotationModel>
  revision: number
  disabled?: boolean
  onCriterionChange?: (
    criterionId: string,
    status: PlanAcceptanceStatus,
    evidence: string | null
  ) => void
  onAnnotate?: (body: string) => void
}) {
  const [annotation, setAnnotation] = useState("")

  return (
    <article className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-md border border-purple/30 bg-purple/10 px-2 py-1 font-mono text-[10px] font-semibold text-purple">
          {stage.id}
        </span>
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-text-bright">{stage.title}</h2>
          {stage.intent && <p className="mt-1 text-[12px] text-muted-foreground">{stage.intent}</p>}
        </div>
      </div>

      {stage.markdown && <Markdown className="mt-4 text-[13px]">{stage.markdown}</Markdown>}

      <section className="mt-5">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">
          Acceptance criteria
        </h3>
        <div className="mt-2 space-y-2">
          {stage.acceptance.map((criterion) => (
            <PlanAcceptance
              key={`${revision}-${criterion.id}`}
              criterion={criterion}
              disabled={disabled}
              onChange={(status, evidence) =>
                onCriterionChange?.(criterion.id, status, evidence)
              }
            />
          ))}
        </div>
      </section>

      {annotations.length > 0 && (
        <div className="mt-4 space-y-2">
          {annotations.map((item) => <PlanAnnotation key={item.id} annotation={item} />)}
        </div>
      )}

      {!disabled && (
        <div className="mt-4 flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Annotate {stage.title}</span>
            <textarea
              value={annotation}
              onChange={(event) => setAnnotation(event.target.value)}
              placeholder="Add an instruction, concern, or decision for the agent…"
              rows={2}
              className="w-full resize-y rounded-lg border border-line bg-editor px-3 py-2 text-[11.5px] leading-relaxed text-text outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={annotation.trim().length === 0}
            onClick={() => {
              const body = annotation.trim()
              if (body.length === 0) return
              onAnnotate?.(body)
              setAnnotation("")
            }}
          >
            <MessageSquarePlus className="size-3.5" />
            Annotate
          </Button>
        </div>
      )}
    </article>
  )
}
