import { mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { MessageSquareText } from "lucide-react"

/**
 * `<aside data-annotation="a1" data-stage="01" data-author="user" …>body</aside>`
 * — a comment thread anchored to a stage (or global).
 *
 * Annotations are chrome, not prose: the card presents author + status and the
 * body, but the surrounding attributes (anchor quote/prefix/suffix, timestamps)
 * are metadata the HTML engine round-trips rather than something the user edits
 * here. Only set attributes are re-emitted, keeping the serialized markup tidy.
 */

function AnnotationView({ node }: NodeViewProps) {
  const author = (node.attrs.author as string) || "user"
  const status = (node.attrs.status as string) || "open"
  return (
    <NodeViewWrapper className="my-2">
      <aside className="rounded-lg border border-purple/30 bg-purple/5 p-3">
        <div
          className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-purple"
          contentEditable={false}
        >
          <MessageSquareText className="size-3.5" />
          {author} annotation · {status}
        </div>
        <NodeViewContent className="mt-2 text-[12px] leading-relaxed text-text-body" />
      </aside>
    </NodeViewWrapper>
  )
}

export const PlanAnnotationNode = Node.create({
  name: "planAnnotation",
  group: "block",
  content: "inline*",

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
      }
    }
  },

  parseHTML() {
    return [{ tag: "aside[data-annotation]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AnnotationView)
  }
})
