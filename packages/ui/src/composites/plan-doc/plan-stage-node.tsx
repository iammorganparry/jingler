import { mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { cn } from "../../lib/cn.js"

/**
 * `<section data-stage="01" data-title="…">…children…</section>` — a plan stage.
 *
 * The stage is a block container (`content: "block+"`) so its body (intent,
 * approach, acceptance criteria, annotations) is ordinary editable document
 * content. `parseHTML`/`renderHTML` round-trip the two data-attributes the HTML
 * plan engine (`@jingler/core` `plan-html.ts`) reads back, so what the editor
 * emits re-parses to the same PlanPrd projection.
 */

function StageView({ node }: NodeViewProps) {
  const [open, setOpen] = useState(true)
  const id = (node.attrs.id as string) || "—"
  const title = (node.attrs.title as string) || "Untitled stage"
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <NodeViewWrapper className="my-4 overflow-hidden rounded-xl border border-line bg-panel">
      <div
        className="flex items-center gap-2 border-b border-line px-4 py-2.5"
        contentEditable={false}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-none rounded text-dim transition-colors hover:text-text"
          aria-label={open ? "Collapse stage" : "Expand stage"}
        >
          <Chevron className="size-4" />
        </button>
        <span className="rounded-md border border-purple/30 bg-purple/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-purple">
          {id}
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-text-bright">{title}</span>
      </div>
      <NodeViewContent className={cn("px-4 py-3", !open && "hidden")} />
    </NodeViewWrapper>
  )
}

export const PlanStageNode = Node.create({
  name: "planStage",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-stage") ?? "",
        renderHTML: (attrs) => ({ "data-stage": attrs.id })
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (attrs) => ({ "data-title": attrs.title })
      }
    }
  },

  parseHTML() {
    return [{ tag: "section[data-stage]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(StageView)
  }
})
