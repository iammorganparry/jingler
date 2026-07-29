import { mergeAttributes, Node } from "@tiptap/core"
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react"
import { Workflow } from "lucide-react"
import { useEffect, useState } from "react"
import { MermaidDiagram } from "../../components/mermaid-diagram.js"

/**
 * `<div data-diagram="mermaid"><pre>graph TD; A--&gt;B</pre></div>` — an
 * embeddable flow diagram.
 *
 * The node is an atom: the mermaid source lives in a `source` attribute rather
 * than as editable document content, so ProseMirror never tries to treat the
 * `<pre>` as a code block. The node view renders the live diagram
 * (`MermaidDiagram`) above a small source textarea whose edits flow back into
 * the attribute; `renderHTML` re-emits the `<pre>` the HTML engine expects.
 */

function DiagramView({ node, updateAttributes, editor }: NodeViewProps) {
  const source = (node.attrs.source as string) ?? ""
  const [draft, setDraft] = useState(source)

  // An external source change (undo/redo, remote revision) must win over the
  // local draft; sync down when the attribute and draft diverge.
  useEffect(() => {
    setDraft((current) => (current === source ? current : source))
  }, [source])

  return (
    <NodeViewWrapper className="my-3" contentEditable={false}>
      <div className="overflow-hidden rounded-md border border-line">
        <div className="flex w-full items-center gap-[9px] bg-surface px-2.5 py-1.5 font-mono text-[11.5px]">
          <Workflow className="size-3 shrink-0 text-blue" />
          <span className="text-muted-foreground">flow</span>
          <span className="flex-1" />
          <span className="shrink-0 text-dim">mermaid</span>
        </div>
        <div className="border-t border-line bg-editor px-3 py-2">
          <MermaidDiagram source={draft} />
        </div>
        {editor.isEditable && (
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              updateAttributes({ source: event.target.value })
            }}
            rows={3}
            spellCheck={false}
            aria-label="Mermaid diagram source"
            placeholder="graph TD; A--&gt;B"
            className="w-full resize-y border-t border-line bg-editor px-3 py-2 font-mono text-[11px] leading-[1.5] text-text-body outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const PlanDiagramNode = Node.create({
  name: "planDiagram",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: "",
        // The source is the <pre> text, not an attribute — so parse it out of
        // the child and never re-emit it as an attribute (renderHTML builds the
        // <pre> instead).
        parseHTML: (el) => el.querySelector("pre")?.textContent ?? "",
        renderHTML: () => ({})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-diagram="mermaid"]', priority: 100 }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-diagram": "mermaid" }),
      ["pre", (node.attrs.source as string) ?? ""]
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView)
  }
})
