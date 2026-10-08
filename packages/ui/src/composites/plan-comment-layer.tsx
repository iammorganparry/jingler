import type { PlanAnnotation } from "@jingler/core"
import { Check, MessageSquare, RotateCcw } from "lucide-react"
import { useEffect, useState, type RefObject } from "react"
import { Button } from "../components/button.js"
import { domRangeFromAnchor } from "./plan-doc/plan-anchor-dom.js"

interface Highlight {
  readonly id: string
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly detached: boolean
}

export interface PlanCommentLayerProps {
  readonly container: RefObject<HTMLDivElement | null>
  readonly content: RefObject<HTMLElement | null>
  readonly comments: ReadonlyArray<PlanAnnotation>
  readonly editable: boolean
  readonly onReply: (id: string, body: string) => void
  readonly onResolve: (id: string, resolved: boolean) => void
}

const detachedHighlight = (id: string): Highlight => ({ id, top: 0, left: 0, width: 0, height: 0, detached: true })

/** Where one comment's quote sits in the scroller, or nothing when it has no anchor or no box. */
const highlightFor = (comment: PlanAnnotation, body: HTMLElement, root: HTMLElement, base: DOMRect): Highlight[] => {
  if (comment.anchor === undefined) return []
  if (!(body.textContent ?? "").includes(comment.anchor.quote)) return [detachedHighlight(comment.id)]
  const range = domRangeFromAnchor(body, comment.anchor)
  if (range === null) return [detachedHighlight(comment.id)]
  const rect = range.getBoundingClientRect()
  // Text inside a folded stage has no box; it isn't detached, just not drawn.
  if (rect.width === 0 && rect.height === 0) return []
  return [{
    id: comment.id,
    top: rect.top - base.top + root.scrollTop,
    left: rect.left - base.left + root.scrollLeft,
    width: rect.width,
    height: rect.height,
    detached: false
  }]
}

export function PlanCommentLayer({ container, content, comments, editable, onReply, onResolve }: PlanCommentLayerProps) {
  const [highlights, setHighlights] = useState<ReadonlyArray<Highlight>>([])
  const [replies, setReplies] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    const root = container.current
    const body = content.current
    if (root === null || body === null) return setHighlights([])
    const recompute = () => {
      const base = root.getBoundingClientRect()
      setHighlights(comments.flatMap((comment) => highlightFor(comment, body, root, base)))
    }
    recompute()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recompute)
    observer?.observe(body)
    body.addEventListener("toggle", recompute, true)
    return () => {
      observer?.disconnect()
      body.removeEventListener("toggle", recompute, true)
    }
  }, [comments, container, content])

  if (comments.length === 0) return null
  const detached = new Set(highlights.filter((highlight) => highlight.detached).map((highlight) => highlight.id))

  return (
    <>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {highlights.filter((highlight) => !highlight.detached).map((highlight) => (
          <mark
            key={highlight.id}
            data-comment-highlight={highlight.id}
            className="absolute rounded-sm bg-yellow/25"
            style={{ top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height }}
          />
        ))}
      </div>
      <aside aria-label="Plan comments" className="mx-auto mt-5 flex max-w-[760px] flex-col gap-2 px-8 pb-10">
        {comments.map((comment) => (
          <article key={comment.id} data-comment-thread={comment.id} className="rounded-lg border border-line bg-panel p-3 text-[13px]">
            <header className="mb-2 flex items-center gap-2 text-muted-foreground">
              <MessageSquare className="size-3.5" />
              <span>{comment.stageId === null ? "Plan" : comment.stageId}</span>
              {detached.has(comment.id) && <span className="text-yellow">Detached from changed text</span>}
              <button
                type="button"
                disabled={!editable}
                className="ml-auto inline-flex items-center gap-1 text-[10.5px] hover:text-text-bright disabled:opacity-50"
                onClick={() => onResolve(comment.id, comment.status === "open")}
              >
                {comment.status === "open" ? <><Check className="size-3" /> Resolve</> : <><RotateCcw className="size-3" /> Reopen</>}
              </button>
            </header>
            {comment.anchor && <q className="mb-2 block border-l-2 border-yellow/40 pl-2 text-muted-foreground">{comment.anchor.quote}</q>}
            <div className="space-y-1.5">
              {comment.messages.map((message) => <p key={message.id} className="m-0 text-text-body">{message.body}</p>)}
            </div>
            {editable && comment.status === "open" && (
              <div className="mt-2 flex gap-2">
                <input
                  aria-label={`Reply to ${comment.id}`}
                  value={replies[comment.id] ?? ""}
                  placeholder="Reply…"
                  onChange={(event) => setReplies((current) => ({ ...current, [comment.id]: event.target.value }))}
                  className="min-w-0 flex-1 rounded border border-line bg-editor px-2 py-1 outline-none"
                />
                <Button size="sm" disabled={(replies[comment.id] ?? "").trim().length === 0} onClick={() => {
                  onReply(comment.id, replies[comment.id] ?? "")
                  setReplies((current) => ({ ...current, [comment.id]: "" }))
                }}>Reply</Button>
              </div>
            )}
          </article>
        ))}
      </aside>
    </>
  )
}
