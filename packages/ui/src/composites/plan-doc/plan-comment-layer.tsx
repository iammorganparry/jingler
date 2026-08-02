import type { PlanAnnotation, PlanAnnotationAnchor, PlanCommentMessage, PlanParticipant } from "@jingler/core"
import { MessageSquarePlus, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { cn } from "../../lib/cn.js"
import { buildAnchorFromRange, domRangeFromAnchor } from "./plan-anchor-dom.js"
import {
  PlanCommentComposer,
  PlanCommentThread,
  PlanCommentThreadControlsProvider
} from "./plan-comment-thread.js"

/**
 * The comment surface over the read-only plan document (design screen 03).
 *
 * Rendered into `PlanDocView`'s `commentLayer` seam as an absolute overlay above
 * the sanitized HTML. It positions three kinds of affordance off the live DOM of
 * the rendered document (handed in as `containerRef`): a "comment on this step"
 * button per `[data-stage]`, a floating "Add comment" prompt over a text
 * selection (anchored via a W3C TextQuote), and a pin per existing annotation
 * that opens its thread. Anchored spans are highlighted with overlay rects; an
 * anchor that no longer resolves after an agent revision is shown as an orphaned
 * (dashed) pin rather than dropped, so the conversation is never lost.
 */

export interface PlanCommentLayerProps {
  readonly annotations: ReadonlyArray<PlanAnnotation>
  readonly participants: ReadonlyArray<PlanParticipant>
  /** The rendered read-only doc element (PlanDocView's scroll container). */
  readonly containerRef: HTMLElement | null
  readonly onAddComment: (
    target: { readonly stageId?: string; readonly anchor?: PlanAnnotationAnchor },
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  readonly onReply: (
    annotationId: string,
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<void> | void
  readonly onSetResolved: (annotationId: string, resolved: boolean) => Promise<void> | void
  readonly onRetry?: (annotationId: string, message: PlanCommentMessage) => Promise<void> | void
  readonly disabled?: boolean
}

interface HighlightRect {
  readonly key: string
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly resolved: boolean
}
interface Pin {
  readonly id: string
  readonly top: number
  readonly left: number
  readonly count: number
  readonly resolved: boolean
  readonly orphan: boolean
}
interface Affordance {
  readonly stageId: string
  readonly top: number
  readonly left: number
}
type Composer =
  | { readonly kind: "stage"; readonly stageId: string; readonly top: number; readonly left: number }
  | { readonly kind: "anchor"; readonly anchor: PlanAnnotationAnchor; readonly top: number; readonly left: number }
interface SelectionPrompt {
  readonly anchor: PlanAnnotationAnchor
  readonly top: number
  readonly left: number
}

export function PlanCommentLayer({
  annotations,
  participants,
  containerRef,
  onAddComment,
  onReply,
  onSetResolved,
  onRetry,
  disabled
}: PlanCommentLayerProps) {
  const [rects, setRects] = useState<ReadonlyArray<HighlightRect>>([])
  const [pins, setPins] = useState<ReadonlyArray<Pin>>([])
  const [stages, setStages] = useState<ReadonlyArray<Affordance>>([])
  const [composer, setComposer] = useState<Composer | null>(null)
  const [selection, setSelection] = useState<SelectionPrompt | null>(null)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)

  const recompute = useCallback(() => {
    const container = containerRef
    if (container === null) {
      setRects([])
      setPins([])
      setStages([])
      return
    }
    const base = container.getBoundingClientRect()
    // The overlays are absolute children of the SCROLLING container, so their
    // top/left must be in CONTENT space (viewport offset + scroll), not viewport
    // space — otherwise every overlay drifts by the scroll amount and clips.
    const { scrollTop, scrollLeft } = container
    const toTop = (viewportTop: number) => viewportTop - base.top + scrollTop
    const toLeft = (viewportLeft: number) => viewportLeft - base.left + scrollLeft
    const rightEdge = scrollLeft + container.clientWidth - 28

    const nextRects: Array<HighlightRect> = []
    const nextPins: Array<Pin> = []
    annotations.forEach((annotation, index) => {
      let orphan = false
      // Unanchored / orphaned pins stack at the top of the content.
      let pinTop = 8 + index * 30
      if (annotation.anchor !== undefined) {
        const range = domRangeFromAnchor(container, annotation.anchor)
        const clientRects = range === null ? [] : Array.from(range.getClientRects())
        if (clientRects.length === 0) {
          orphan = true
        } else {
          clientRects.forEach((r, i) => {
            nextRects.push({
              key: `${annotation.id}:${i}`,
              top: toTop(r.top),
              left: toLeft(r.left),
              width: r.width,
              height: r.height,
              resolved: annotation.status === "resolved"
            })
          })
          pinTop = toTop(clientRects[0]!.top)
        }
      }
      nextPins.push({
        id: annotation.id,
        top: pinTop,
        left: rightEdge,
        count: annotation.messages.length,
        resolved: annotation.status === "resolved",
        orphan
      })
    })
    setRects(nextRects)
    setPins(nextPins)

    setStages(
      Array.from(container.querySelectorAll<HTMLElement>("[data-stage]"))
        .map((section) => {
          const r = section.getBoundingClientRect()
          return {
            stageId: section.getAttribute("data-stage") ?? "",
            top: toTop(r.top) + 6,
            left: toLeft(r.right) - 8
          }
        })
        .filter((s) => s.stageId.length > 0)
    )
  }, [annotations, containerRef])

  useEffect(() => {
    recompute()
    // Content-space positions are scroll-invariant, so recompute only when the
    // annotations or the container SIZE change — not on every scroll frame.
    window.addEventListener("resize", recompute)
    return () => window.removeEventListener("resize", recompute)
  }, [recompute])

  useEffect(() => {
    const container = containerRef
    if (container === null) return
    const doc = container.ownerDocument ?? document
    const onSelect = () => {
      const sel = doc.getSelection()
      if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelection(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null)
        return
      }
      const anchor = buildAnchorFromRange(container, range)
      if (anchor === null) {
        setSelection(null)
        return
      }
      const base = container.getBoundingClientRect()
      const rect = range.getBoundingClientRect()
      setSelection({
        anchor,
        top: rect.bottom - base.top + container.scrollTop + 4,
        left: rect.left - base.left + container.scrollLeft
      })
    }
    doc.addEventListener("selectionchange", onSelect)
    container.addEventListener("mouseup", onSelect)
    return () => {
      doc.removeEventListener("selectionchange", onSelect)
      container.removeEventListener("mouseup", onSelect)
    }
  }, [containerRef])

  const controls = useMemo(
    () => ({ participants, disabled, onReply, onRetry, onSetResolved }),
    [participants, disabled, onReply, onRetry, onSetResolved]
  )

  const submit = useCallback(
    async (body: string, mentions: ReadonlyArray<string>) => {
      if (composer === null) return
      await onAddComment(
        composer.kind === "stage" ? { stageId: composer.stageId } : { anchor: composer.anchor },
        body,
        mentions
      )
      setComposer(null)
    },
    [composer, onAddComment]
  )

  const openAnnotation = openThreadId === null ? undefined : annotations.find((a) => a.id === openThreadId)
  const openPin = openThreadId === null ? undefined : pins.find((p) => p.id === openThreadId)

  return (
    <PlanCommentThreadControlsProvider controls={controls}>
      {/* No overflow-hidden: highlights live in content space and must paint
          below the first viewport as the plan scrolls. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {rects.map((rect) => (
          <mark
            key={rect.key}
            className={cn("absolute rounded-[2px]", rect.resolved ? "bg-green/15" : "bg-yellow/25")}
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          />
        ))}
      </div>

      {stages.map((stage) => (
        <button
          key={stage.stageId}
          type="button"
          disabled={disabled}
          aria-label="Comment on this step"
          onClick={() => {
            setOpenThreadId(null)
            setComposer({ kind: "stage", stageId: stage.stageId, top: stage.top + 24, left: stage.left - 260 })
          }}
          className="pointer-events-auto absolute z-10 flex size-6 -translate-x-full items-center justify-center rounded-md border border-line bg-panel text-muted-foreground opacity-60 transition-opacity hover:text-text-bright hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
          style={{ top: stage.top, left: stage.left }}
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      ))}

      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          aria-label={pin.orphan ? "Detached comment thread" : "Comment thread"}
          onClick={() => {
            setComposer(null)
            setOpenThreadId((current) => (current === pin.id ? null : pin.id))
          }}
          className={cn(
            "pointer-events-auto absolute z-10 flex h-6 min-w-6 items-center justify-center rounded-full border px-1.5 text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pin.resolved ? "border-line bg-surface text-muted-foreground" : "border-yellow/40 bg-yellow/10 text-yellow",
            pin.orphan && "border-dashed opacity-70"
          )}
          style={{ top: pin.top, left: pin.left }}
        >
          {pin.count}
        </button>
      ))}

      {selection !== null && composer === null && (
        <button
          type="button"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpenThreadId(null)
            setComposer({ kind: "anchor", anchor: selection.anchor, top: selection.top, left: selection.left })
            setSelection(null)
          }}
          className="pointer-events-auto absolute z-20 inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-2 py-1 text-[10.5px] text-text-bright shadow-lg outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
          style={{ top: selection.top, left: selection.left }}
        >
          <MessageSquarePlus className="size-3" /> Add comment
        </button>
      )}

      {composer !== null && (
        <div
          className="pointer-events-auto absolute z-30 w-[280px] rounded-lg border border-line bg-editor p-2 shadow-xl"
          style={{ top: composer.top, left: Math.max(8, composer.left) }}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {composer.kind === "stage" ? "Comment on step" : "Comment on selection"}
            </span>
            <button
              type="button"
              aria-label="Cancel comment"
              onClick={() => setComposer(null)}
              className="text-dim outline-none hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {/* No @mentions on the CREATE path: a new comment is batched to the
              agent by revisePlan, not dispatched, so a mention here has no
              delivery semantics (unlike a reply). Offering it would silently
              drop it. Mentions live on the reply composer inside PlanCommentThread. */}
          <PlanCommentComposer
            participants={[]}
            autoFocus
            disabled={disabled}
            placeholder="Add a comment…"
            onSubmit={submit}
            onCancel={() => setComposer(null)}
          />
        </div>
      )}

      {openAnnotation !== undefined && openPin !== undefined && (
        <div
          className="pointer-events-auto absolute z-30 w-[300px] overflow-hidden rounded-lg border border-line bg-editor shadow-xl"
          style={{ top: openPin.top, left: Math.max(8, openPin.left - 308) }}
        >
          {openAnnotation.anchor !== undefined && openPin.orphan && (
            <p className="border-b border-line bg-yellow/5 px-3 py-1.5 text-[9.5px] text-yellow">
              This comment’s highlighted text has changed and can no longer be located.
            </p>
          )}
          <PlanCommentThread
            annotationId={openAnnotation.id}
            status={openAnnotation.status}
            messages={openAnnotation.messages}
          />
        </div>
      )}
    </PlanCommentThreadControlsProvider>
  )
}
