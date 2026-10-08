import { planStageExecutionStatus, type PlanFile, type PlanPrdStage } from "@jingler/core"
import { Check, ChevronRight, Circle, CircleDot, MessageSquarePlus, MinusCircle, X } from "lucide-react"
import { useState, type ReactNode } from "react"
import { useOpenPath } from "../asset/open-asset-context.js"
import { Badge, type BadgeTone } from "../components/badge.js"
import { DiffStat } from "../components/diff-stat.js"
import { FileIcon } from "../components/file-icon.js"
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

const complexityTone = { low: "blue", medium: "yellow", high: "red" } as const satisfies Record<string, BadgeTone>

/** VS Code's SCM letters: one coloured glyph says the change kind without a pill. */
const change = {
  A: { label: "New file", className: "text-green" },
  M: { label: "Modified", className: "text-yellow" },
  D: { label: "Deleted", className: "text-red" }
} as const satisfies Record<PlanFile["change"], { label: string; className: string }>

const acceptanceIcon = {
  passed: Check,
  failed: X,
  waived: MinusCircle,
  pending: Circle
} as const

/** One labelled part of a stage. The label reads as a sub-heading, not a footnote. */
function Part({ label, title, count, children }: {
  readonly label: string
  readonly title: string
  readonly count?: number
  readonly children: ReactNode
}) {
  return (
    <section aria-label={label} className="mt-8">
      <h3 className="sb-plan-label">
        {title}
        {count !== undefined && <span className="font-normal text-dim">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

/** A repo path that opens in Files when the worktree has it, else plain text. */
function PathLink({ path }: { readonly path: string }) {
  const open = useOpenPath(path)
  if (open === null) return path
  return (
    <button type="button" onClick={open} className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-blue">
      {path}
    </button>
  )
}

/**
 * File name first, directory dimmed after it — the name is what a reviewer
 * scans for. Both wrap anywhere, so a deep Java package path never truncates.
 */
function StageFile({ file }: { readonly file: PlanFile }) {
  const open = useOpenPath(file.path)
  const kind = change[file.change]
  const slash = file.path.lastIndexOf("/")
  const name = file.path.slice(slash + 1)
  const dir = slash < 0 ? "" : file.path.slice(0, slash)
  const changed = (file.added ?? 0) + (file.removed ?? 0) > 0
  const row = "flex w-full min-w-0 items-start gap-2.5 px-3 py-2 text-left"
  const content = (
    <>
      <span title={kind.label} className={`w-3 flex-none text-center font-mono text-[12px] font-semibold leading-[20px] ${kind.className}`}>
        {file.change}
      </span>
      <FileIcon path={file.path} size={14} className="mt-[3px] flex-none" />
      <span title={file.path} className="flex min-w-0 flex-1 items-baseline gap-2 font-mono text-[13px] leading-[20px]">
        <span className={`max-w-full flex-none truncate text-text-bright ${file.change === "D" ? "line-through decoration-red/60" : ""}`}>{name}</span>
        {dir.length > 0 && <span className="min-w-0 truncate text-[12px] text-dim">{dir}</span>}
      </span>
      {changed && <DiffStat added={file.added ?? 0} removed={file.removed} className="mt-[3px] flex-none text-[11px]" />}
    </>
  )
  return (
    <li data-change={file.change}>
      {open === null ? <div className={row}>{content}</div> : (
        <button
          type="button"
          aria-label={`Open ${file.path}${changed ? ` (+${file.added ?? 0} −${file.removed ?? 0})` : ""}`}
          onClick={open}
          className={`${row} cursor-pointer hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-ring`}
        >
          {content}
        </button>
      )}
    </li>
  )
}

const jumpToStage = (from: HTMLElement, id: string) =>
  [...from.ownerDocument.querySelectorAll<HTMLElement>("[data-stage]")]
    .find((element) => element.dataset.stage === id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" })

type StageProps = {
  readonly stage: PlanPrdStage
  readonly number: number
  /** Every stage in the plan, so dependencies read as "Stage 1 · Title". */
  readonly stages?: ReadonlyArray<PlanPrdStage>
  readonly onComment?: (stageId: string) => void
}

function StageHeader({ stage, number, stages = [], onComment }: StageProps) {
  const status = planStageExecutionStatus(stage)
  const deliverable = stage.deliverable ?? stage.intent
  return (
    <header>
      <div className="flex items-center gap-2 text-[12px] text-dim">
        <span className="font-mono font-medium tracking-wide">
          STAGE {number}{stages.length > 0 && ` OF ${stages.length}`}
        </span>
        {stage.complexity && <Badge tone={complexityTone[stage.complexity]} size="xs">{stage.complexity} complexity</Badge>}
        {status === "completed" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green/15 px-2 py-px font-medium text-green">
            <Check className="size-3" strokeWidth={3} /> Done
          </span>
        ) : status !== "queued" && <Badge tone={statusTone[status]} size="xs">{status}</Badge>}
        {onComment && (
          <button
            type="button"
            aria-label={`Comment on ${stage.title}`}
            onClick={() => onComment(stage.id)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface hover:text-text-bright"
          >
            <MessageSquarePlus className="size-3.5" /> Comment
          </button>
        )}
      </div>
      <h2 id={`stage-${stage.id}`} className="sb-plan-title mt-2">{stage.title}</h2>
      {deliverable.length > 0 && <Markdown className="sb-plan-lead mt-2">{deliverable}</Markdown>}
      {(stage.dependencies ?? []).length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
          Starts after
          {stage.dependencies?.map((id) => {
            const index = stages.findIndex((candidate) => candidate.id === id)
            return (
              <button
                key={id}
                type="button"
                onClick={(event) => jumpToStage(event.currentTarget, id)}
                className="rounded border border-line px-1.5 py-px text-text-bright hover:border-line-strong hover:bg-surface"
              >
                {index < 0 ? id : `Stage ${index + 1} · ${stages[index]?.title}`}
              </button>
            )
          })}
        </p>
      )}
    </header>
  )
}

function Tasks({ stage }: { readonly stage: PlanPrdStage }) {
  const tasks = stage.tasks ?? []
  if (tasks.length === 0) return null
  return (
    <Part label={`${stage.title} tasks`} title="Tasks" count={tasks.length}>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-start gap-2.5" data-task-status={task.status}>
            {task.status === "completed"
              ? <Check className="mt-[5px] size-4 flex-none text-green" />
              : <Circle className="mt-[5px] size-4 flex-none text-dim" />}
            <div className="min-w-0">
              <Markdown className={task.status === "completed" ? "text-muted-foreground" : "text-text-bright"}>{task.text}</Markdown>
              {task.description !== undefined && (
                <Markdown className="mt-0.5 text-[14px] text-muted-foreground">{task.description}</Markdown>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Part>
  )
}

function Acceptance({ stage }: { readonly stage: PlanPrdStage }) {
  if (stage.acceptance.length === 0) return null
  return (
    <Part label={`${stage.title} acceptance criteria`} title="How we'll know it works">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {stage.acceptance.map((criterion) => {
          const Icon = acceptanceIcon[criterion.status]
          return (
            <li key={criterion.id} className="flex items-start gap-2.5">
              <Icon className="mt-[5px] size-4 flex-none text-dim" />
              <div className="min-w-0">
                <Markdown>{criterion.text}</Markdown>
                {(criterion.testReferences ?? []).map((reference) => (
                  <code key={`${reference.path}:${reference.cases.join(",")}`} className="mt-1 block font-mono text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
                    {reference.kind ?? "test"} · <PathLink path={reference.path} />::{reference.cases.join(", ")}
                  </code>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </Part>
  )
}

/**
 * One stage of a plan, laid out in the order a reviewer decides: what it
 * delivers, how it's built, which files, the technical detail, then the proof.
 */
export function PlanStageCard({ stage, number, stages = [], onComment }: StageProps) {
  const details = [...stage.notes, ...(stage.walkthrough ?? [])]
  const done = stage.definitionOfDone ?? []
  const completed = planStageExecutionStatus(stage) === "completed"
  // Finished stages start folded so the reader's eye lands on the work still ahead.
  const [open, setOpen] = useState(!completed)

  return (
    <section
      data-stage={stage.id}
      data-toc={`stage:${stage.id}`}
      data-status={completed ? "completed" : undefined}
      aria-labelledby={`stage-${stage.id}`}
      className="mt-14 scroll-mt-8 border-t border-line pt-10 data-[status=completed]:border-green/40"
    >
      <StageHeader stage={stage} number={number} stages={stages} onComment={onComment} />

      {completed && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="mt-3 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-surface hover:text-text-bright"
        >
          <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
          {open ? "Hide stage details" : "Show stage details"}
        </button>
      )}

      {open && <>

      {stage.userStory !== undefined && (
        <section
          aria-label={`${stage.title} user story`}
          className="mt-6 rounded-md border-l-2 border-blue bg-surface/40 px-4 py-3 text-[14px]"
        >
          <span className="font-semibold text-text-bright">As {stage.userStory.article ?? "a"}</span> {stage.userStory.role},{" "}
          <span className="font-semibold text-text-bright">I want</span> {stage.userStory.capability},{" "}
          <span className="font-semibold text-text-bright">so that</span> {stage.userStory.benefit}.
        </section>
      )}

      {stage.approach.length > 0 && (
        <Part label={`${stage.title} approach`} title="What changes">
          <ol className="sb-plan-steps">
            {stage.approach.map((step) => <li key={`${stage.id}:${step}`}><Markdown>{step}</Markdown></li>)}
          </ol>
        </Part>
      )}

      <Tasks stage={stage} />

      {stage.files.length > 0 && (
        <Part label={`${stage.title} files`} title="Files touched" count={stage.files.length}>
          <ul className="m-0 list-none divide-y divide-line overflow-hidden rounded-md border border-line p-0">
            {stage.files.map((file) => <StageFile key={`${file.change}:${file.path}`} file={file} />)}
          </ul>
        </Part>
      )}

      {stage.diagrams.length > 0 && (
        <Part label={`${stage.title} flow`} title="How it flows">
          {stage.diagrams.map((diagram) => (
            <div key={diagram.id} className="mt-2 overflow-hidden rounded-md border border-line bg-editor p-2">
              <MermaidDiagram source={diagram.source} />
            </div>
          ))}
        </Part>
      )}

      {details.length > 0 && (
        <Part label={`${stage.title} technical details`} title="Technical details">
          <VisualBlocks blocks={details} />
        </Part>
      )}

      <Acceptance stage={stage} />

      {done.length > 0 && (
        <Part label={`${stage.title} definition of done`} title="Definition of done">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {done.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <CircleDot className="mt-[5px] size-4 flex-none text-dim" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}
      </>}
    </section>
  )
}
