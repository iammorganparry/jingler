import { mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import { CheckCircle2, Circle, CircleSlash2, XCircle } from "lucide-react"
import { cn } from "../../lib/cn.js"

/**
 * `<div data-acceptance="01.1" data-status="pending" data-evidence="…">criterion</div>`
 * — a stage's acceptance criterion.
 *
 * The status is an editable pill: clicking it cycles
 * pending → passed → failed → waived (the four `PlanAcceptanceStatus` values),
 * writing back to `data-status` via `updateAttributes`. The colours mirror
 * `../plan-acceptance.tsx` so the doc editor and the read-only rail agree.
 */

const STATUSES = ["pending", "passed", "failed", "waived"] as const
type Status = (typeof STATUSES)[number]

const STATUS_META: Record<Status, { label: string; className: string; icon: typeof Circle }> = {
  pending: { label: "Pending", className: "text-muted-foreground", icon: Circle },
  passed: { label: "Passed", className: "text-green", icon: CheckCircle2 },
  failed: { label: "Failed", className: "text-red", icon: XCircle },
  waived: { label: "Waived", className: "text-yellow", icon: CircleSlash2 }
}

function AcceptanceView({ node, updateAttributes, editor }: NodeViewProps) {
  const status = (node.attrs.status as Status) ?? "pending"
  const meta = STATUS_META[status] ?? STATUS_META.pending
  const Icon = meta.icon
  const cycle = () => {
    const i = STATUSES.indexOf(status)
    updateAttributes({ status: STATUSES[(i + 1) % STATUSES.length] })
  }
  return (
    <NodeViewWrapper className="my-2">
      <div className="flex items-start gap-2.5 rounded-lg border border-line bg-sunken p-3">
        <button
          type="button"
          contentEditable={false}
          onClick={cycle}
          disabled={!editor.isEditable}
          className={cn(
            "mt-0.5 flex flex-none items-center gap-1.5 rounded-md border border-line bg-editor px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            meta.className
          )}
          aria-label={`Acceptance status: ${meta.label}. Click to change.`}
        >
          <Icon className="size-3.5" />
          <span>{meta.label}</span>
        </button>
        <NodeViewContent className="min-w-0 flex-1 self-center text-[12px] leading-relaxed text-text-body" />
      </div>
    </NodeViewWrapper>
  )
}

export const PlanAcceptanceNode = Node.create({
  name: "planAcceptance",
  group: "block",
  content: "inline*",

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-acceptance") ?? "",
        renderHTML: (attrs) => ({ "data-acceptance": attrs.id })
      },
      status: {
        default: "pending",
        parseHTML: (el) => el.getAttribute("data-status") ?? "pending",
        renderHTML: (attrs) => ({ "data-status": attrs.status })
      },
      evidence: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-evidence"),
        renderHTML: (attrs) => (attrs.evidence ? { "data-evidence": attrs.evidence } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: "div[data-acceptance]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AcceptanceView)
  }
})
