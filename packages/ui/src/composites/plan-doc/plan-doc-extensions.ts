import type { Extensions } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { PlanAcceptanceNode } from "./plan-acceptance-node.js"
import { PlanAnnotationNode } from "./plan-annotation-node.js"
import { PlanDiagramNode } from "./plan-diagram-node.js"
import { PlanStageNode } from "./plan-stage-node.js"

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
 */
export const planDocExtensions = (): Extensions => [
  StarterKit,
  PlanStageNode,
  PlanAcceptanceNode,
  PlanAnnotationNode,
  PlanDiagramNode
]
