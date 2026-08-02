import ListItem from "@tiptap/extension-list-item"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { FileChip } from "../../components/file-chip.js"
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
  return (
    <NodeViewWrapper
      as="li"
      className="min-w-0 max-w-full list-none"
      data-plan-file-path={path}
    >
      <FileChip
        path={path}
        added={added}
        removed={removed}
        onOpen={openable ? controls.open : undefined}
      >
        <NodeViewContent className="min-w-0 text-center [&>p]:m-0" />
      </FileChip>
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
