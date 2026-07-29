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
  return (
    <NodeViewWrapper className="my-4 overflow-hidden rounded-md border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        contentEditable={false}
        aria-expanded={open}
        aria-label={open ? "Collapse stage" : "Expand stage"}
        className="flex min-h-10 w-full items-center gap-[9px] bg-surface px-2.5 py-1.5 text-left font-mono text-[11.5px] outline-none transition-colors hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative size-3 shrink-0 text-line-strong">
          <ChevronDown
            className={cn(
              "absolute inset-0 size-3 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
              open ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"
            )}
          />
          <ChevronRight
            className={cn(
              "absolute inset-0 size-3 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
              open ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"
            )}
          />
        </span>
        <span className="shrink-0 rounded-[3px] border border-purple/30 bg-purple/10 px-1.5 py-0.5 font-semibold text-purple">
          {id}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-bright">{title}</span>
      </button>
      <NodeViewContent
        className={cn(
          "border-t border-line bg-editor px-3 py-2 text-[13px] leading-relaxed text-text-body",
          !open && "hidden"
        )}
      />
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
