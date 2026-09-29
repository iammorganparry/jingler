import { planStageExecutionStatus, type PlanPrdStage } from "@jingler/core"
import { Check, ChevronRight, Circle, MessageSquarePlus, MinusCircle, X } from "lucide-react"
import { useOpenAsset } from "../asset/open-asset-context.js"
import { Badge, type BadgeTone } from "../components/badge.js"
import { FileChip } from "../components/file-chip.js"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { Markdown } from "../components/markdown.js"
import { VisualBlocks } from "./visual-blocks.js"

const statusTone: Record<ReturnType<typeof planStageExecutionStatus>, BadgeTone> = {
  queued: "neutral",
  running: "blue",
  blocked: "yellow",
  failed: "red",
  interrupted: "yellow",
  completed: "green"
}

const acceptanceIcon = {
  passed: Check,
  failed: X,
  waived: MinusCircle,
  pending: Circle
} as const

const deliverableOf = (stage: PlanPrdStage): string => stage.deliverable ?? stage.intent

function TicketUserStory({ stage }: { readonly stage: PlanPrdStage }) {
  if (stage.userStory === undefined) return null
  return (
    <section aria-label={`${stage.title} user story`} className="mt-3 rounded-md border border-line bg-sunken px-3 py-2 text-[12px] text-text-body">
      <span className="font-semibold text-text-bright">As {stage.userStory.article ?? "a"}</span> {stage.userStory.role},{" "}
      <span className="font-semibold text-text-bright">I want</span> {stage.userStory.capability},{" "}
      <span className="font-semibold text-text-bright">so that</span> {stage.userStory.benefit}.
    </section>
  )
}

function DefinitionOfDone({ stage }: { readonly stage: PlanPrdStage }) {
  if ((stage.definitionOfDone?.length ?? 0) === 0) return null
  return (
    <section className="mt-4" aria-label={`${stage.title} definition of done`}>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Definition of done</h3>
      <ul className="m-0 space-y-1 p-0">
        {stage.definitionOfDone?.map((item) => (
          <li key={item} className="flex items-start gap-2 text-[12px] text-text-body">
            <Circle className="mt-0.5 size-3.5 flex-none text-dim" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function PlanStageCard({
  stage,
  number,
  onComment
}: {
  readonly stage: PlanPrdStage
  readonly number: number
  readonly onComment?: (stageId: string) => void
}) {
  const assets = useOpenAsset()
  const status = planStageExecutionStatus(stage)
  const deliverable = deliverableOf(stage)
  const details = [...stage.notes, ...(stage.walkthrough ?? [])]

  return (
    <section
      data-stage={stage.id}
      aria-labelledby={`stage-${stage.id}`}
      className="rounded-lg border border-line bg-panel p-4"
    >
      <header className="flex items-start gap-3">
        <span className="font-mono text-[10px] text-dim">{String(number).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <h2 id={`stage-${stage.id}`} className="m-0 text-[14px] font-semibold text-text-bright">{stage.title}</h2>
          {deliverable.length > 0 && <div className="mt-1 text-[12.5px] text-text-body"><Markdown>{deliverable}</Markdown></div>}
        </div>
        {stage.complexity && <Badge tone={stage.complexity === "high" ? "red" : stage.complexity === "medium" ? "yellow" : "blue"} size="xs">{stage.complexity}</Badge>}
        <Badge tone={statusTone[status]} size="xs">{status}</Badge>
        {onComment && (
          <button type="button" aria-label={`Comment on ${stage.title}`} onClick={() => onComment(stage.id)} className="text-dim hover:text-text-bright">
            <MessageSquarePlus className="size-4" />
          </button>
        )}
      </header>

      <TicketUserStory stage={stage} />

      {stage.dependencies && stage.dependencies.length > 0 && (
        <section className="mt-3 flex flex-wrap gap-1.5" aria-label="Dependencies">
          {stage.dependencies.map((dependency) => <Badge key={dependency} size="xs">after {dependency}</Badge>)}
        </section>
      )}

      {stage.approach.length > 0 && (
        <ol className="mt-3 space-y-1 pl-5 text-[12.5px] text-text-body">
          {stage.approach.map((step) => <li key={`${stage.id}:${step}`}><Markdown>{step}</Markdown></li>)}
        </ol>
      )}

      {(stage.tasks ?? []).length > 0 && (
        <section className="mt-4" aria-label={`${stage.title} tasks`}>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tasks</h3>
          <ul className="m-0 space-y-1 p-0">
            {(stage.tasks ?? []).map((task) => (
              <li key={task.id} className="flex items-start gap-2 text-[12px] text-text-body" data-task-status={task.status}>
                {task.status === "completed" ? <Check className="mt-0.5 size-3.5 text-green" /> : <Circle className="mt-0.5 size-3.5 text-dim" />}
                <span>{task.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stage.files.length > 0 && (
        <section className="mt-4" aria-label={`${stage.title} files`}>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Files</h3>
          <div className="flex flex-wrap gap-1.5">
            {stage.files.map((file) => (
              <FileChip
                key={`${file.change}:${file.path}`}
                path={file.path}
                added={file.added}
                removed={file.removed}
                onOpen={assets?.knownFiles.has(file.path) ? assets.open : undefined}
              >
                {file.change} · {file.path}
              </FileChip>
            ))}
          </div>
        </section>
      )}

      {stage.diagrams.map((diagram) => (
        <div key={diagram.id} className="mt-4 overflow-hidden rounded-md border border-line bg-editor p-2">
          <MermaidDiagram source={diagram.source} />
        </div>
      ))}

      {stage.acceptance.length > 0 && (
        <section className="mt-4" aria-label={`${stage.title} acceptance criteria`}>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Acceptance criteria</h3>
          <ul className="m-0 space-y-2 p-0">
            {stage.acceptance.map((criterion) => {
              const Icon = acceptanceIcon[criterion.status]
              return (
                <li key={criterion.id} className="flex items-start gap-2 text-[12px] text-text-body">
                  <Icon className="mt-0.5 size-3.5 flex-none text-dim" />
                  <div className="min-w-0">
                    <Markdown>{criterion.text}</Markdown>
                    {(criterion.testReferences ?? []).map((reference) => (
                      <code key={`${reference.path}:${reference.cases.join(",")}`} className="block text-[10.5px] text-muted-foreground">
                        {reference.kind ?? "test"} · {reference.path}::{reference.cases.join(", ")}
                      </code>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <DefinitionOfDone stage={stage} />

      {details.length > 0 && (
        <details className="group mt-4 border-t border-line pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Technical details
          </summary>
          <VisualBlocks blocks={details} className="mt-3" />
        </details>
      )}
    </section>
  )
}
