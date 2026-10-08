import type { PlanAnnotation, PlanAnnotationAnchor, PlanDocument, PlanPrd } from "@jingler/core"
import { MessageSquarePlus } from "lucide-react"
import { useEffect, useRef, useState, type RefObject } from "react"
import { Button } from "../components/button.js"
import { PlanRevisionDiff } from "../composites/plan-change-block.js"
import { PlanCommentLayer } from "../composites/plan-comment-layer.js"
import { loadPlanComments, savePlanComments } from "../composites/plan-comment-store.js"
import { buildAnchorFromRange } from "../composites/plan-doc/plan-anchor-dom.js"
import { PlanStageCard } from "../composites/plan-stage-card.js"
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

type Selection = {
  readonly quote: string
  readonly stageId?: string
  readonly anchor?: PlanAnnotationAnchor
  readonly top: number
  readonly left: number
}

const currentSelection = (root: HTMLElement, scroller: HTMLElement | null): Selection | null => {
  const selected = root.ownerDocument.getSelection()
  if (selected === null || selected.rangeCount === 0) return null
  const quote = selected.toString().trim()
  if (quote.length === 0) return null
  const range = selected.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const anchor = buildAnchorFromRange(root, range)
  if (anchor === null) return null
  const node = range.commonAncestorContainer
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  const base = (scroller ?? root).getBoundingClientRect()
  const rect = range.getBoundingClientRect()
  return {
    quote,
    anchor,
    stageId: element?.closest("[data-stage]")?.getAttribute("data-stage") ?? undefined,
    top: rect.bottom - base.top + (scroller?.scrollTop ?? 0) + 4,
    left: rect.left - base.left + (scroller?.scrollLeft ?? 0)
  }
}

interface ContentsItem {
  readonly id: string
  readonly label: string
  readonly number: number | undefined
}

/** Sticky contents rail; highlights whichever section is at the top of the reader's view. */
function PlanContents({ items, scroller }: { readonly items: ReadonlyArray<ContentsItem>; readonly scroller: RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the rendered sections change
  useEffect(() => {
    const root = scroller.current
    if (root === null || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => {
      const top = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      const id = top?.target.getAttribute("data-toc")
      if (id) setActive(id)
    }, { root, rootMargin: "0px 0px -70% 0px" })
    for (const element of root.querySelectorAll("[data-toc]")) observer.observe(element)
    return () => observer.disconnect()
  }, [items, scroller])
  if (items.length < 2) return null
  const jump = (id: string) =>
    [...(scroller.current?.querySelectorAll<HTMLElement>("[data-toc]") ?? [])]
      .find((element) => element.dataset.toc === id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  return (
    <nav aria-label="Plan contents" className="sticky top-10 hidden max-h-[calc(100vh-120px)] w-52 flex-none self-start overflow-y-auto @min-[1000px]:block">
      <p className="m-0 mb-2 px-2 font-mono text-[11px] uppercase tracking-wide text-dim">Contents</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-current={active === item.id ? "location" : undefined}
              onClick={() => jump(item.id)}
              className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[13px] leading-snug text-muted-foreground hover:bg-surface hover:text-text-bright aria-[current]:bg-surface aria-[current]:text-text-bright"
            >
              {item.number !== undefined && <span className="flex-none font-mono text-[11px] text-dim">{item.number}</span>}
              <span className="min-w-0">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function PlanReview({ document, canApprove = true, onApprove, onRevise }: PlanReviewProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLElement | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState<Selection | null>(null)
  const [draftBody, setDraftBody] = useState("")
  const commentIdentity = `${document.sessionId}:${document.producingChatId}:${document.id}`
  const commentIdentityRef = useRef(commentIdentity)
  const [comments, setComments] = useState<ReadonlyArray<PlanAnnotation>>(() => {
    const saved = loadPlanComments(commentIdentity)
    return saved.length > 0 ? saved : document.plan.annotations
  })
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
    if (commentIdentityRef.current !== commentIdentity) {
      commentIdentityRef.current = commentIdentity
      const saved = loadPlanComments(commentIdentity)
      setComments(saved.length > 0 ? saved : document.plan.annotations)
      return
    }
    savePlanComments(commentIdentity, comments)
  }, [commentIdentity, comments, document.plan.annotations])

  useEffect(() => {
    const root = content.current
    if (root === null || !canDecide) return
    const onMouseUp = () => setSelection(currentSelection(root, container.current))
    root.addEventListener("mouseup", onMouseUp)
    return () => root.removeEventListener("mouseup", onMouseUp)
  }, [canDecide])

  const decide = async (approved: boolean) => {
    setBusy(true)
    setDecisionError(null)
    try {
      if (approved) await onApprove?.()
      else await onRevise?.(planFeedbackMarkdown(
        plan,
        comments.filter((comment) => comment.status === "open").map((comment) => ({
          stageId: comment.stageId ?? undefined,
          quote: comment.anchor?.quote ?? plan.stages.find((stage) => stage.id === comment.stageId)?.title ?? plan.title,
          body: comment.messages.map((message) => message.body).join("\n\n")
        })),
        general
      ))
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Could not send your decision.")
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = () => {
    const body = draftBody.trim()
    if (draft === null || body.length === 0) return
    const createdAt = new Date().toISOString()
    const id = crypto.randomUUID()
    setComments((current) => [...current, {
      id,
      stageId: draft.stageId ?? null,
      body,
      author: "user",
      createdAt,
      status: "open",
      ...(draft.anchor === undefined ? {} : { anchor: draft.anchor }),
      messages: [{
        id: crypto.randomUUID(), body, authorKind: "user", authorId: "operator", createdAt,
        mentionedParticipantIds: [], deliveryState: "sent"
      }]
    }])
    setDraft(null)
    setDraftBody("")
  }

  const commentOnStage = (stageId: string) => {
    const root = container.current
    const stage = root?.querySelector<HTMLElement>(`[data-stage="${stageId}"]`)
    const base = root?.getBoundingClientRect()
    const rect = stage?.getBoundingClientRect()
    setDraft({ stageId, quote: stageId, top: rect && base ? rect.top - base.top + (root?.scrollTop ?? 0) + 28 : 16, left: rect && base ? rect.left - base.left + 28 : 16 })
  }

  const reply = (id: string, body: string) => setComments((current) => current.map((comment) =>
    comment.id !== id ? comment : {
      ...comment,
      messages: [...comment.messages, {
        id: crypto.randomUUID(), body: body.trim(), authorKind: "user" as const, authorId: "operator",
        createdAt: new Date().toISOString(), mentionedParticipantIds: [], deliveryState: "sent" as const
      }]
    }
  ))

  const resolve = (id: string, resolved: boolean) => setComments((current) => current.map((comment) =>
    comment.id === id ? { ...comment, status: resolved ? "resolved" as const : "open" as const } : comment
  ))

  const fileCount = new Set(plan.stages.flatMap((stage) => stage.files.map((file) => file.path))).size
  const contents = [
    ...plan.sections.filter((section) => section.title.length > 0).map((section) => ({ id: `section:${section.id}`, label: section.title, number: undefined })),
    ...plan.stages.map((stage, index) => ({ id: `stage:${stage.id}`, label: stage.title, number: index + 1 }))
  ]

  return (
    <section aria-label="Plan review" data-testid="plan-review" className="flex min-h-0 min-w-0 flex-1 flex-col bg-editor">
      <div ref={container} className="@container relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1120px] gap-10 px-8 py-10">
          <PlanContents items={contents} scroller={container} />
        <article ref={content} className="sb-plan flex min-w-0 max-w-[760px] flex-1 flex-col">
          <header className="border-b border-line pb-8">
            <p className="m-0 font-mono text-[12px] uppercase tracking-wide text-dim">
              Plan · revision {document.revision} · {document.status}
            </p>
            <h1 className="sb-plan-doc-title mt-2">{plan.title}</h1>
            {plan.stages.length > 0 && (
              <p className="mt-3 text-[14px] text-muted-foreground">
                {plan.stages.length} {plan.stages.length === 1 ? "stage" : "stages"} · {fileCount} {fileCount === 1 ? "file" : "files"} touched
              </p>
            )}
            {document.previousSourceMarkdown !== undefined && document.sourceMarkdown !== undefined && (
              <div className="mt-4 flex flex-col gap-2">
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
          </header>
          {plan.sections.map((section) => (
            <section key={section.id} data-section={section.id} data-toc={`section:${section.id}`} className="mt-10 scroll-mt-8">
              {section.title.length > 0 && <h2 className="sb-plan-heading">{section.title}</h2>}
              <VisualBlocks blocks={section.blocks} />
            </section>
          ))}
          {plan.stages.map((stage, index) => (
            <PlanStageCard key={stage.id} stage={stage} number={index + 1} stages={plan.stages} onComment={canDecide ? commentOnStage : undefined} />
          ))}
        </article>
        </div>

        <PlanCommentLayer key={document.revision} container={container} content={content} comments={comments} editable={canDecide} onReply={reply} onResolve={resolve} />

        {selection !== null && draft === null && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setDraft(selection)
              setSelection(null)
            }}
            className="absolute z-20 inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-2 py-1 text-[12px] text-text-bright shadow-lg"
            style={{ top: selection.top, left: selection.left }}
          >
            <MessageSquarePlus className="size-3" /> Add comment
          </button>
        )}
        {draft !== null && (
          <div
            className="absolute z-30 w-[320px] rounded-lg border border-line bg-editor p-2 shadow-xl"
            style={{ top: draft.top, left: Math.max(8, draft.left) }}
          >
            <textarea
              aria-label="Comment"
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              rows={3}
              className="w-full resize-none rounded border border-line bg-editor p-1.5 text-[13px] outline-none"
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
          {decisionError !== null && <p role="alert" className="text-[11.5px] text-red">{decisionError}</p>}
          <div className="flex items-end gap-2">
            <textarea
              aria-label="General feedback"
              placeholder="General feedback (optional)"
              value={general}
              onChange={(event) => setGeneral(event.target.value)}
              rows={1}
              className="min-w-0 flex-1 resize-none rounded border border-line bg-editor px-2 py-1.5 text-[13px] outline-none"
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
