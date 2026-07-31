import {
  planLegacyCommentMessageId,
  type PlanCommentMessage
} from "@jingler/core"
import { mergeAttributes, Node, type NodeViewProps } from "@tiptap/core"
import {
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { MessageSquareText } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { cn } from "../../lib/cn.js"
import { resolvePlanCommentRange } from "./plan-doc-comment.js"
import { PlanCommentThread } from "./plan-comment-thread.js"

/**
 * `<aside data-annotation="a1" data-stage="01" data-author="user" …>body</aside>`
 * — a comment thread anchored to a stage (or global).
 *
 * Annotations are chrome, not prose: the surrounding attributes (anchor
 * quote/prefix/suffix, timestamps) are metadata the HTML engine round-trips
 * rather than something the user edits here. Only set attributes are re-emitted,
 * keeping the serialized markup tidy.
 *
 * Rendering follows Notion's comment model rather than an inline card: the
 * persisted TextQuote anchor resolves back to the highlighted line, a bubble is
 * portalled into that line's right gutter, and the comment card is itself
 * portalled so no editor/stage overflow can clip it. Only the NodeView changes —
 * the node still serializes to the same `<aside data-annotation>` markup.
 */

interface MarkerPosition {
  readonly left: number
  readonly top: number
}

const scrollViewport = (element: HTMLElement): DOMRect => {
  let parent = element.parentElement
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY
    if (overflowY === "auto" || overflowY === "scroll") return parent.getBoundingClientRect()
    parent = parent.parentElement
  }
  return document.documentElement.getBoundingClientRect()
}

function AnnotationView({ editor, node }: NodeViewProps) {
  const annotationId = typeof node.attrs.id === "string" ? node.attrs.id : ""
  const author = node.attrs.author === "agent" ? "agent" : "user"
  const status = node.attrs.status === "resolved" ? "resolved" : "open"
  const quote = typeof node.attrs.quote === "string" ? node.attrs.quote : ""
  const prefix = typeof node.attrs.prefix === "string" ? node.attrs.prefix : ""
  const suffix = typeof node.attrs.suffix === "string" ? node.attrs.suffix : ""
  const messages = planCommentMessagesFrom(node.attrs.messages)

  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState<MarkerPosition | null>(null)
  const markerRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number | null>(null)

  const updatePosition = useCallback(() => {
    if (quote.length === 0 || editor.isDestroyed) {
      setPosition(null)
      return
    }
    const range = resolvePlanCommentRange(editor.state.doc, { quote, prefix, suffix })
    if (range === null) {
      setPosition(null)
      return
    }
    const line = editor.view.coordsAtPos(range.from)
    const documentRect = editor.view.dom.getBoundingClientRect()
    const viewport = scrollViewport(editor.view.dom)
    if (line.bottom < viewport.top || line.top > viewport.bottom) {
      setPosition(null)
      return
    }
    const size = 24
    setPosition({
      left: Math.min(documentRect.right - size - 8, window.innerWidth - size - 8),
      top: line.top + Math.max(0, (line.bottom - line.top - size) / 2)
    })
  }, [editor, prefix, quote, suffix])

  useLayoutEffect(() => {
    updatePosition()
    const schedule = () => window.requestAnimationFrame(updatePosition)
    editor.on("transaction", schedule)
    window.addEventListener("resize", schedule)
    // Capture scrolls from the nested plan/editor scrollers.
    window.addEventListener("scroll", schedule, true)
    return () => {
      editor.off("transaction", schedule)
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
    }
  }, [editor, updatePosition])

  // A pinned popover is dismissible: Escape, or a pointer-down outside it.
  useEffect(() => {
    if (!pinned) return
    const onDown = (event: MouseEvent) => {
      if (markerRef.current?.contains(event.target as globalThis.Node)) return
      const target = event.target
      if (target instanceof Element && target.closest(`[data-plan-comment-card="${annotationId}"]`)) {
        return
      }
      setPinned(false)
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [annotationId, pinned])

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    []
  )

  const showCard = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    setOpen(true)
  }

  const scheduleClose = () => {
    if (pinned) return
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120)
  }

  const cardTop =
    position === null ? 8 : Math.max(8, Math.min(position.top, window.innerHeight - 260))
  const marker =
    position === null
      ? null
      : createPortal(
          <>
            <button
              ref={markerRef}
              type="button"
              contentEditable={false}
              aria-label={`${author} annotation, ${status}`}
              aria-expanded={open}
              onMouseEnter={showCard}
              onMouseLeave={scheduleClose}
              onFocus={showCard}
              onBlur={scheduleClose}
              onClick={() => {
                const nextPinned = !pinned
                setPinned(nextPinned)
                setOpen(nextPinned)
              }}
              className={cn(
                "fixed z-40 flex size-6 select-none items-center justify-center rounded-full border border-purple/40 bg-purple/10 text-purple outline-none transition-[background-color,opacity,scale] duration-150 ease-out after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 hover:bg-purple/20 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]",
                open && "bg-purple/20",
                status === "resolved" && "opacity-60"
              )}
              style={{ left: position.left, top: position.top }}
            >
              <MessageSquareText className="size-3.5" />
            </button>
            <div
              role="dialog"
              aria-label={`${author} annotation`}
              aria-hidden={!open}
              onMouseEnter={showCard}
              onMouseLeave={scheduleClose}
              className={cn(
                "fixed z-50 w-[min(22rem,calc(100vw-1rem))] origin-top-right overflow-hidden rounded-xl border border-line bg-panel shadow-lg transition-[opacity,filter,transform] duration-150 ease-out",
                open
                  ? "translate-y-0 opacity-100 blur-0"
                  : "pointer-events-none -translate-y-1 opacity-0 blur-[4px]"
              )}
              style={{
                left: Math.max(8, position.left - Math.min(352, window.innerWidth - 16)),
                top: cardTop,
                maxHeight: window.innerHeight - cardTop - 8
              }}
              data-plan-comment-card={annotationId}
            >
              <PlanCommentThread
                annotationId={annotationId}
                status={status}
                messages={messages}
              />
            </div>
          </>,
          document.body
        )

  return (
    <NodeViewWrapper className="h-0 overflow-visible">
      {marker}
    </NodeViewWrapper>
  )
}

const deliveryStates = new Set(["pending", "sent", "failed"])

const mentionedParticipantIdsFrom = (element: Element): ReadonlyArray<string> => {
  const encoded = element.getAttribute("data-mentioned-participant-ids")
  if (encoded === null) return []
  try {
    const decoded: unknown = JSON.parse(encoded)
    return Array.isArray(decoded)
      ? decoded.filter((value): value is string => typeof value === "string")
      : []
  } catch {
    return []
  }
}

const planCommentMessagesFrom = (value: unknown): ReadonlyArray<PlanCommentMessage> => {
  if (!Array.isArray(value)) return []
  return value.filter((message): message is PlanCommentMessage => {
    if (typeof message !== "object" || message === null) return false
    const candidate = message as Partial<PlanCommentMessage>
    return (
      typeof candidate.id === "string" &&
      typeof candidate.body === "string" &&
      (candidate.authorKind === "user" || candidate.authorKind === "agent") &&
      typeof candidate.authorId === "string" &&
      typeof candidate.createdAt === "string" &&
      Array.isArray(candidate.mentionedParticipantIds) &&
      deliveryStates.has(candidate.deliveryState ?? "")
    )
  })
}

const messagesFromElement = (element: HTMLElement): ReadonlyArray<PlanCommentMessage> => {
  const nested = Array.from(element.children).filter((child) =>
    child.hasAttribute("data-comment-message")
  )
  if (nested.length > 0) {
    return nested.map((child) => {
      const authorKind = child.getAttribute("data-author-kind") === "agent" ? "agent" : "user"
      const delivery = child.getAttribute("data-delivery-state") ?? "sent"
      return {
        id: child.getAttribute("data-comment-message") ?? "",
        body: child.textContent ?? "",
        authorKind,
        authorId: child.getAttribute("data-author-id") ?? authorKind,
        createdAt: child.getAttribute("data-created-at") ?? "",
        mentionedParticipantIds: mentionedParticipantIdsFrom(child),
        deliveryState: deliveryStates.has(delivery)
          ? (delivery as PlanCommentMessage["deliveryState"])
          : "sent"
      }
    })
  }

  const annotationId = element.getAttribute("data-annotation") ?? ""
  const authorKind = element.getAttribute("data-author") === "agent" ? "agent" : "user"
  const status = element.getAttribute("data-status") === "resolved" ? "resolved" : "open"
  return [
    {
      id: planLegacyCommentMessageId(annotationId),
      body: element.textContent ?? "",
      authorKind,
      authorId: element.getAttribute("data-author-id") ?? authorKind,
      createdAt: element.getAttribute("data-created-at") ?? "",
      mentionedParticipantIds: [],
      deliveryState: authorKind === "agent" || status === "resolved" ? "sent" : "pending"
    }
  ]
}

export const PlanAnnotationNode = Node.create({
  name: "planAnnotation",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-annotation") ?? "",
        renderHTML: (attrs) => ({ "data-annotation": attrs.id })
      },
      stageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-stage"),
        renderHTML: (attrs) => (attrs.stageId ? { "data-stage": attrs.stageId } : {})
      },
      author: {
        default: "user",
        parseHTML: (el) => (el.getAttribute("data-author") === "agent" ? "agent" : "user"),
        renderHTML: (attrs) => ({ "data-author": attrs.author })
      },
      status: {
        default: "open",
        parseHTML: (el) => (el.getAttribute("data-status") === "resolved" ? "resolved" : "open"),
        renderHTML: (attrs) => ({ "data-status": attrs.status })
      },
      quote: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-quote"),
        renderHTML: (attrs) => (attrs.quote ? { "data-quote": attrs.quote } : {})
      },
      prefix: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-prefix"),
        renderHTML: (attrs) => (attrs.prefix ? { "data-prefix": attrs.prefix } : {})
      },
      suffix: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-suffix"),
        renderHTML: (attrs) => (attrs.suffix ? { "data-suffix": attrs.suffix } : {})
      },
      createdAt: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-created-at"),
        renderHTML: (attrs) => (attrs.createdAt ? { "data-created-at": attrs.createdAt } : {})
      },
      messages: {
        default: [],
        parseHTML: (element) => messagesFromElement(element as HTMLElement),
        renderHTML: () => ({})
      }
    }
  },

  parseHTML() {
    return [{ tag: "aside[data-annotation]" }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const messages = planCommentMessagesFrom(node.attrs.messages)
    return [
      "aside",
      mergeAttributes(HTMLAttributes),
      ...messages.map((message) => [
        "div",
        {
          "data-comment-message": message.id,
          "data-author-kind": message.authorKind,
          "data-author-id": message.authorId,
          "data-created-at": message.createdAt,
          "data-mentioned-participant-ids": JSON.stringify(
            message.mentionedParticipantIds
          ),
          "data-delivery-state": message.deliveryState
        },
        message.body
      ])
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AnnotationView)
  }
})
