import { Extension } from "@tiptap/core"
import type { Extensions } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { PlanAcceptanceNode } from "./plan-acceptance-node.js"
import { PlanAnnotationNode } from "./plan-annotation-node.js"
import { PlanDiagramNode } from "./plan-diagram-node.js"
import { PlanCommentDecorations } from "./plan-doc-comment.js"
import { PlanSlashCommand } from "./plan-doc-slash.js"
import { PlanAssignmentNode, PlanStageNode } from "./plan-stage-node.js"

const PlanFileOwnershipMetadata = Extension.create({
  name: "planFileOwnershipMetadata",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList"],
        attributes: {
          planFiles: {
            default: null,
            parseHTML: (element) =>
              element.hasAttribute("data-files") ? "" : null,
            renderHTML: (attributes) =>
              attributes.planFiles === null ? {} : { "data-files": "" }
          }
        }
      },
      {
        types: ["listItem"],
        attributes: {
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
      }
    ]
  }
})

/**
 * The Tiptap extension set behind the full-document plan editor.
 *
 * Exported so the HTML round-trip can be exercised headlessly in tests
 * (`new Editor({ extensions: planDocExtensions() })`) with the exact same schema
 * the live editor uses — a divergence there would let a round-trip test pass
 * while the real editor corrupts a plan's structural markup.
 *
 * StarterKit supplies the prose (headings, paragraphs, lists, blockquote, code);
 * the four custom nodes carry the plan structure on data-attributes so the
 * serialized HTML re-parses to the same PlanPrd projection (`@jingler/core`).
 * `PlanCommentDecorations` derives comment highlights from persisted TextQuote
 * anchors; `PlanSlashCommand` supplies the `/` insert menu that replaced the
 * toolbar.
 *
 * `PlanSlashCommand` is optional so the headless round-trip test can build the
 * exact schema without pulling in the suggestion/React popup machinery.
 */
export const planDocExtensions = ({ slash = true }: { slash?: boolean } = {}): Extensions => [
  StarterKit,
  PlanFileOwnershipMetadata,
  PlanStageNode,
  PlanAssignmentNode,
  PlanAcceptanceNode,
  PlanAnnotationNode,
  PlanDiagramNode,
  PlanCommentDecorations,
  ...(slash ? [PlanSlashCommand] : [])
]
