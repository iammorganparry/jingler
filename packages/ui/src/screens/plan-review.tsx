import type { PlanDocument, PlanPrd, PlanPrdStage } from "@jingler/core"
import { MessageSquarePlus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "../components/button.js"
import { Markdown } from "../components/markdown.js"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { PlanRevisionDiff } from "../composites/plan-change-block.js"
import { VisualBlocks } from "../composites/visual-blocks.js"

export interface PlanReviewComment {
  readonly stageId?: string
  readonly quote: string
  readonly body: string
}

export interface PlanReviewProps {
  readonly document: PlanDocument
  readonly canApprove?: boolean
  readonly onApprove?: () => void | Promise<void>
  readonly onRevise?: (feedback?: string) => void | Promise<void>
}

const PLANNOTATOR_ID_PREFIX = /^plannotator:/

const blockquote = (text: string): string =>
  text.split("\n").map((line) => `> ${line}`).join("\n")

/** Deny feedback in the same "Plan Feedback" markdown shape upstream Plannotator sent. */
export const planFeedbackMarkdown = (
  plan: PlanPrd,
  comments: ReadonlyArray<PlanReviewComment>,
  general: string
): string | undefined => {
  const note = general.trim()
  if (comments.length === 0 && note.length === 0) return undefined
  const stageTitle = (id: string | undefined) =>
    plan.stages.find((stage) => stage.id === id)?.title
  const parts = ["# Plan Feedback"]
  comments.forEach((comment, index) => {
    const title = stageTitle(comment.stageId)
    parts.push(
      "",
      `## ${index + 1}. ${title === undefined ? "Plan" : `${title} (${comment.stageId})`}`,
      blockquote(comment.quote),
      "",
      comment.body.trim()
    )
  })
  if (note.length > 0) parts.push("", "## General", note)
  return parts.join("\n")
}

function AcceptanceTable({ stage }: { stage: PlanPrdStage }) {
  if (stage.acceptance.length === 0) return null
  return (
    <>
    <h3 className="sb-plan-heading">Acceptance</h3>
    <div className="overflow-x-auto">
      <table aria-label={`${stage.title} acceptance`}>
        <thead><tr><th>Kind</th><th>Criterion</th><th>Test</th></tr></thead>
        <tbody>
          {stage.acceptance.map((criterion) => {
            const references = criterion.testReferences ?? []
            return (
              <tr key={criterion.id}>
                <td>{references.map((ref) => ref.kind ?? "—").join(", ") || "—"}</td>
                <td><Markdown>{criterion.text}</Markdown></td>
                <td className="font-mono text-[11px]">
                  {references.map((ref) => `${ref.path}::${ref.cases.join(", ")}`).join("; ") || "—"}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    </>
  )
}

function StageView({ stage }: { stage: PlanPrdStage }) {
  const tasks = stage.tasks ?? []
  const body = [...stage.notes, ...(stage.walkthrough ?? [])]
  return (
    <section data-stage={stage.id} aria-labelledby={`stage-${stage.id}`} className="border-t border-line pt-4">
      <h2 id={`stage-${stage.id}`} className="sb-plan-heading">{stage.title}</h2>
      {stage.intent.length > 0 && <Markdown>{stage.intent}</Markdown>}
      {stage.approach.length > 0 && (
        <>
          <h3 className="sb-plan-heading">Approach</h3>
          <ul>{stage.approach.map((step, index) => <li key={index}><Markdown>{step}</Markdown></li>)}</ul>
        </>
      )}
      {body.length > 0 && <VisualBlocks blocks={body} />}
      {stage.diagrams.map((diagram) => <MermaidDiagram key={diagram.id} source={diagram.source} />)}
      {tasks.length > 0 && (
        <>
          <h3 className="sb-plan-heading">Tasks</h3>
          <ul>
            {tasks.map((task) => (
              <li key={task.id} data-task-status={task.status}>
                {task.status === "completed" ? "☑" : "☐"} {task.text}
              </li>
            ))}
          </ul>
        </>
      )}
      <AcceptanceTable stage={stage} />
      {stage.files.length > 0 && (
        <>
          <h3 className="sb-plan-heading">Files</h3>
          <ul>{stage.files.map((file) => <li key={file.path}><code>{file.path}</code> — {file.change}</li>)}</ul>
        </>
      )}
    </section>
  )
}

type Selection = { readonly quote: string; readonly stageId?: string; readonly top: number; readonly left: number }

export function PlanReview({ document, canApprove = true, onApprove, onRevise }: PlanReviewProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState<Selection | null>(null)
  const [draftBody, setDraftBody] = useState("")
  const [comments, setComments] = useState<ReadonlyArray<PlanReviewComment>>([])
  const [general, setGeneral] = useState("")
  const [busy, setBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  const canDecide =
    canApprove &&
    document.reviewId !== undefined &&
    (document.status === "proposed" || document.status === "revising")
  const { plan } = document

  useEffect(() => {
    const root = container.current
    if (root === null || !canDecide) return
    const onMouseUp = () => {
      const current = root.ownerDocument.getSelection()
      const quote = current?.toString().trim() ?? ""
      if (current === null || current.rangeCount === 0 || quote.length === 0) return setSelection(null)
      const range = current.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return setSelection(null)
      const node = range.commonAncestorContainer
      const element = node.nodeType === 1 ? (node as Element) : node.parentElement
      const base = root.getBoundingClientRect()
      const rect = range.getBoundingClientRect()
      setSelection({
        quote,
        stageId: element?.closest("[data-stage]")?.getAttribute("data-stage") ?? undefined,
        top: rect.bottom - base.top + root.scrollTop + 4,
        left: rect.left - base.left + root.scrollLeft
      })
    }
    root.addEventListener("mouseup", onMouseUp)
    return () => root.removeEventListener("mouseup", onMouseUp)
  }, [canDecide])

  const decide = async (approved: boolean) => {
    setBusy(true)
    setDecisionError(null)
    try {
      if (approved) await onApprove?.()
      else await onRevise?.(planFeedbackMarkdown(plan, comments, general))
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Could not send your decision.")
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = () => {
    if (draft === null || draftBody.trim().length === 0) return
    setComments((current) => [
      ...current,
      { stageId: draft.stageId, quote: draft.quote, body: draftBody }
    ])
    setDraft(null)
    setDraftBody("")
  }

  return (
    <section aria-label="Plan review" data-testid="plan-review" className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <div ref={container} className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <article className="sb-plan mx-auto flex max-w-3xl flex-col gap-4 text-[13px] text-text-body">
          <h1 className="text-xl font-semibold text-text-bright">{plan.title}</h1>
          {document.previousSourceMarkdown !== undefined && document.sourceMarkdown !== undefined && (
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                aria-expanded={showChanges}
                onClick={() => setShowChanges((current) => !current)}
              >
                {showChanges ? "Hide changes" : `Changes since revision ${Math.max(1, document.revision - 1)}`}
              </Button>
              {showChanges && (
                <PlanRevisionDiff
                  path={document.id.replace(PLANNOTATOR_ID_PREFIX, "")}
                  before={document.previousSourceMarkdown}
                  after={document.sourceMarkdown}
                />
              )}
            </div>
          )}
          {plan.sections.map((section) => (
            <section key={section.id} data-section={section.id}>
              {section.title.length > 0 && <h2 className="sb-plan-heading">{section.title}</h2>}
              <VisualBlocks blocks={section.blocks} />
            </section>
          ))}
          {plan.stages.map((stage) => <StageView key={stage.id} stage={stage} />)}
        </article>

        {selection !== null && draft === null && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setDraft(selection)
              setSelection(null)
            }}
            className="absolute z-20 inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-2 py-1 text-[10.5px] text-text-bright shadow-lg"
            style={{ top: selection.top, left: selection.left }}
          >
            <MessageSquarePlus className="size-3" /> Add comment
          </button>
        )}
        {draft !== null && (
          <div
            className="absolute z-30 w-[280px] rounded-lg border border-line bg-editor p-2 shadow-xl"
            style={{ top: draft.top, left: Math.max(8, draft.left) }}
          >
            <textarea
              autoFocus
              aria-label="Comment"
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              rows={3}
              className="w-full resize-none rounded border border-line bg-editor p-1.5 text-[11.5px] outline-none"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
              <Button size="sm" disabled={draftBody.trim().length === 0} onClick={saveDraft}>Save comment</Button>
            </div>
          </div>
        )}
      </div>

      {canDecide && (
        <footer className="flex flex-col gap-2 border-t border-line bg-panel px-4 py-3">
          {comments.length > 0 && (
            <ul aria-label="Review comments" className="flex max-h-40 flex-col gap-1 overflow-y-auto text-[11.5px]">
              {comments.map((comment, index) => (
                <li key={index} className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <q className="text-muted-foreground">{comment.quote}</q> — {comment.body}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove comment on ${comment.quote}`}
                    onClick={() => setComments((current) => current.filter((_, i) => i !== index))}
                    className="text-dim hover:text-text-bright"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {decisionError !== null && <p role="alert" className="text-[11.5px] text-red">{decisionError}</p>}
          <div className="flex items-end gap-2">
            <textarea
              aria-label="General feedback"
              placeholder="General feedback (optional)"
              value={general}
              onChange={(event) => setGeneral(event.target.value)}
              rows={1}
              className="min-w-0 flex-1 resize-none rounded border border-line bg-editor px-2 py-1.5 text-[12px] outline-none"
            />
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void decide(false)}>
              Request changes
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void decide(true)}>Approve</Button>
          </div>
        </footer>
      )}
    </section>
  )
}
