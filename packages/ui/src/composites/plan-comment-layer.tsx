import type { PlanAnnotation } from "@jingler/core"
import { Check, MessageSquare, RotateCcw } from "lucide-react"
import { useEffect, useState, type FocusEvent, type RefObject } from "react"
import { Avatar } from "../components/avatar.js"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { cn } from "../lib/cn.js"
import { domRangeFromAnchor } from "./plan-doc/plan-anchor-dom.js"

interface Highlight {
  readonly id: string
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly detached: boolean
  /** Left edge for this comment's avatar: just right of the plan column. */
  readonly gutter: number
}

/** Avatar diameter and how far each stacked avatar steps right (−6px overlap). */
const AVATAR_SIZE = 20
const STACK_STEP = AVATAR_SIZE - 6

export interface PlanCommentLayerProps {
  readonly container: RefObject<HTMLDivElement | null>
  readonly content: RefObject<HTMLElement | null>
  readonly comments: ReadonlyArray<PlanAnnotation>
  readonly editable: boolean
  readonly replyDrafts: Readonly<Record<string, string>>
  readonly onReplyDraftChange: (id: string, text: string) => void
  readonly onReply: (id: string, body: string) => void
  readonly onResolve: (id: string, resolved: boolean) => void
}

interface Frame {
  readonly body: HTMLElement
  readonly root: HTMLElement
  readonly base: DOMRect
}

type Shape = "range" | "point" | "detached"

const toHighlight = (id: string, rect: DOMRect, { body, root, base }: Frame, shape: Shape): Highlight => ({
  id,
  detached: shape === "detached",
  top: rect.top - base.top + root.scrollTop,
  left: rect.left - base.left + root.scrollLeft,
  width: shape === "range" ? rect.width : 0,
  height: shape === "range" ? rect.height : 0,
  gutter: body.getBoundingClientRect().right - base.left + root.scrollLeft + 8
})

/** Where a comment without a drawable range sits: its stage card, else the top of the plan. */
const pointRect = (comment: PlanAnnotation, { body }: Frame): DOMRect =>
  (comment.stageId === null ? null : body.querySelector(`[data-stage="${comment.stageId}"]`))?.getBoundingClientRect() ?? body.getBoundingClientRect()

/** Where one comment's avatar (and quote tint) sits in the scroller, or nothing when its text is folded away. */
const highlightFor = (comment: PlanAnnotation, frame: Frame): Highlight[] => {
  if (comment.anchor === undefined) return [toHighlight(comment.id, pointRect(comment, frame), frame, "point")]
  const range = (frame.body.textContent ?? "").includes(comment.anchor.quote) ? domRangeFromAnchor(frame.body, comment.anchor) : null
  if (range === null) return [toHighlight(comment.id, pointRect(comment, frame), frame, "detached")]
  const rect = range.getBoundingClientRect()
  // Text inside a folded stage has no box; it isn't detached, just not drawn.
  if (rect.width === 0 && rect.height === 0) return []
  return [toHighlight(comment.id, rect, frame, "range")]
}

/** Avatars whose anchors sit within one avatar height of each other fan out rightwards. */
const stackSlots = (highlights: ReadonlyArray<Highlight>): ReadonlyMap<string, number> => {
  const slots = new Map<string, number>()
  let clusterTop = Number.NEGATIVE_INFINITY
  let slot = 0
  for (const highlight of [...highlights].sort((a, b) => a.top - b.top)) {
    if (highlight.top - clusterTop < AVATAR_SIZE) slot += 1
    else {
      clusterTop = highlight.top
      slot = 0
    }
    slots.set(highlight.id, slot)
  }
  return slots
}

interface ThreadCardProps {
  readonly comment: PlanAnnotation
  readonly detached: boolean
  readonly editable: boolean
  readonly replyDraft: string
  readonly onReplyDraftChange: (id: string, text: string) => void
  readonly onReply: (id: string, body: string) => void
  readonly onResolve: (id: string, resolved: boolean) => void
}

function ThreadCard({ comment, detached, editable, replyDraft, onReplyDraftChange, onReply, onResolve }: ThreadCardProps) {
  return (
    <article data-comment-thread={comment.id} className="rounded-lg border border-line bg-surface p-3 text-[13px] shadow-[0_16px_48px_var(--sb-shadow-strong)]">
      <header className="mb-2 flex items-center gap-2 text-muted-foreground">
        <MessageSquare className="size-3.5" />
        <span>{comment.stageId === null ? "Plan" : comment.stageId}</span>
        {detached && <span className="text-state-needs">Detached from changed text</span>}
        <Button variant="ghost" size="sm" disabled={!editable} className="ml-auto h-6 px-2 text-[11px]" onClick={() => onResolve(comment.id, comment.status === "open")}>
          {comment.status === "open" ? <><Check className="size-3" /> Resolve</> : <><RotateCcw className="size-3" /> Reopen</>}
        </Button>
      </header>
      {comment.anchor && <q className="mb-2 block border-l-2 border-line-strong pl-2 text-muted-foreground">{comment.anchor.quote}</q>}
      <div className="space-y-1.5">
        {comment.messages.map((message) => <p key={message.id} className="m-0 text-text-body">{message.body}</p>)}
      </div>
      {editable && comment.status === "open" && (
        <div className="mt-2 flex gap-2">
          <Input
            aria-label={`Reply to ${comment.id}`}
            value={replyDraft}
            placeholder="Reply…"
            onChange={(event) => onReplyDraftChange(comment.id, event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-[6px] px-2 text-[13px]"
          />
          <Button size="sm" disabled={replyDraft.trim().length === 0} onClick={() => {
            onReply(comment.id, replyDraft)
            onReplyDraftChange(comment.id, "")
          }}>Reply</Button>
        </div>
      )}
    </article>
  )
}

interface ThreadAnchorProps extends ThreadCardProps {
  readonly highlight: Highlight
  readonly slot: number
  readonly open: boolean
  readonly onHover: (id: string | null) => void
  readonly onTogglePin: (id: string) => void
}

/** One 20px avatar at its anchored line; hover or focus opens the 320px thread card, click pins it. */
function ThreadAnchor({ highlight, slot, open, onHover, onTogglePin, ...card }: ThreadAnchorProps) {
  const { comment } = card
  const agent = (comment.messages[0]?.authorKind ?? comment.author) === "agent"
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHover(null)
  }
  return (
    <div
      data-comment-avatar={comment.id}
      className={cn("pointer-events-auto absolute rounded-full ring-2 ring-canvas", open ? "z-30" : "z-10")}
      style={{ top: highlight.top, left: highlight.gutter + slot * STACK_STEP }}
      onMouseEnter={() => onHover(comment.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(comment.id)}
      onBlur={leave}
    >
      <Avatar
        size={AVATAR_SIZE}
        initial={agent ? "J" : "Y"}
        label={agent ? "Comment by Jingler" : "Comment by You"}
        agent={agent}
        count={comment.messages.length - 1}
        onClick={() => onTogglePin(comment.id)}
      />
      {open && (
        <div className="absolute right-0 top-full w-[320px] pt-1.5 text-left">
          <ThreadCard {...card} detached={highlight.detached} />
        </div>
      )}
    </div>
  )
}

export function PlanCommentLayer({ container, content, comments, editable, replyDrafts, onReplyDraftChange, onReply, onResolve }: PlanCommentLayerProps) {
  const [highlights, setHighlights] = useState<ReadonlyArray<Highlight>>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const active = pinned ?? hovered

  useEffect(() => {
    const root = container.current
    const body = content.current
    if (root === null || body === null) return setHighlights([])
    const recompute = () => {
      const frame = { body, root, base: root.getBoundingClientRect() }
      setHighlights(comments.flatMap((comment) => highlightFor(comment, frame)))
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

  useEffect(() => {
    if (active === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setHovered(null)
      setPinned(null)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [active])

  if (comments.length === 0) return null
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const slots = stackSlots(highlights)

  return (
    <>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {highlights.filter((highlight) => highlight.width > 0).map((highlight) => (
          <mark
            key={highlight.id}
            data-comment-highlight={highlight.id}
            className={cn("absolute rounded-sm", highlight.id === active ? "bg-state-needs/40" : "bg-state-needs/25")}
            style={{ top: highlight.top, left: highlight.left, width: highlight.width, height: highlight.height }}
          />
        ))}
      </div>
      <aside aria-label="Plan comments" className="pointer-events-none absolute inset-0">
        {highlights.map((highlight) => {
          const comment = byId.get(highlight.id)
          return comment && (
            <ThreadAnchor
              key={highlight.id}
              comment={comment}
              highlight={highlight}
              slot={slots.get(highlight.id) ?? 0}
              open={highlight.id === active}
              detached={highlight.detached}
              editable={editable}
              replyDraft={replyDrafts[comment.id] ?? ""}
              onReplyDraftChange={onReplyDraftChange}
              onReply={onReply}
              onResolve={onResolve}
              onHover={setHovered}
              onTogglePin={(id) => setPinned((current) => (current === id ? null : id))}
            />
          )
        })}
      </aside>
    </>
  )
}
