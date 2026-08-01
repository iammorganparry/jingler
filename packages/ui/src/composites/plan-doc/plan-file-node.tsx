import ListItem from "@tiptap/extension-list-item"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { FileCode2 } from "lucide-react"
import { DiffStat } from "../../components/diff-stat.js"
import { usePlanFileControls } from "./plan-file-controls.js"

const numericAttribute = (value: unknown): number =>
  typeof value === "string" || typeof value === "number"
    ? Number(value) || 0
    : 0

function PlanListItemView({ node, editor, getPos }: NodeViewProps) {
  const position = getPos()
  const parent =
    typeof position === "number" ? editor.state.doc.resolve(position).parent : null
  const isPlanFile = parent?.attrs.planFiles !== null && parent?.attrs.planFiles !== undefined
  const controls = usePlanFileControls()

  if (!isPlanFile) {
    return (
      <NodeViewWrapper as="li">
        <NodeViewContent />
      </NodeViewWrapper>
    )
  }

  const path = node.textContent.trim()
  const live = controls.evidence?.get(path)
  const added = live?.added ?? numericAttribute(node.attrs.planFileAdded)
  const removed = live?.removed ?? numericAttribute(node.attrs.planFileRemoved)
  const diff = added + removed > 0
  const openable =
    path.length > 0 &&
    controls.open !== undefined &&
    (controls.knownFiles === undefined ||
      controls.knownFiles.has(path) ||
      live !== undefined ||
      diff)
  const label = `Open ${path}${diff ? ` (+${added} −${removed})` : ""}`

  return (
    <NodeViewWrapper
      as="li"
      className="my-1 flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[10.5px]"
      data-plan-file-path={path}
    >
      <NodeViewContent className="min-w-0 flex-1 [&>p]:m-0" />
      {openable ? (
        <button
          type="button"
          contentEditable={false}
          aria-label={label}
          title={`${label} in asset viewer`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controls.open?.(path)}
          className="flex shrink-0 items-center gap-1 rounded-sm px-1 text-muted outline-none transition-colors hover:bg-line/30 hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FileCode2 className="size-3" />
          {diff && <DiffStat added={added} removed={removed} />}
        </button>
      ) : (
        diff && (
          <span contentEditable={false} className="shrink-0 text-muted">
            <DiffStat added={added} removed={removed} />
          </span>
        )
      )}
    </NodeViewWrapper>
  )
}

export const PlanListItemNode = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      planFileChange: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-change"),
        renderHTML: (attributes) =>
          typeof attributes.planFileChange === "string"
            ? { "data-change": attributes.planFileChange }
            : {}
      },
      planFileAdded: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-added"),
        renderHTML: (attributes) =>
          typeof attributes.planFileAdded === "string"
            ? { "data-added": attributes.planFileAdded }
            : {}
      },
      planFileRemoved: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-removed"),
        renderHTML: (attributes) =>
          typeof attributes.planFileRemoved === "string"
            ? { "data-removed": attributes.planFileRemoved }
            : {}
      }
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(PlanListItemView)
  }
})
