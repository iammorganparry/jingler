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

const STATUS_META: Record<
  Status,
  { label: string; className: string; border: string; icon: typeof Circle }
> = {
  pending: { label: "Pending", className: "text-yellow", border: "border-yellow/30", icon: Circle },
  passed: { label: "Passed", className: "text-green", border: "border-green/30", icon: CheckCircle2 },
  failed: { label: "Failed", className: "text-red", border: "border-red/35", icon: XCircle },
  waived: { label: "Waived", className: "text-dim", border: "border-line", icon: CircleSlash2 }
}

function AcceptanceView({ node, updateAttributes, editor }: NodeViewProps) {
  const status = (node.attrs.status as Status) ?? "pending"
  const meta = STATUS_META[status] ?? STATUS_META.pending
  const cycle = () => {
    const i = STATUSES.indexOf(status)
    updateAttributes({ status: STATUSES[(i + 1) % STATUSES.length] })
  }
  return (
    <NodeViewWrapper className="my-2 overflow-hidden rounded-md border border-line">
      <div className="flex items-start gap-[9px] bg-surface px-2.5 py-1.5">
        <button
          type="button"
          contentEditable={false}
          onClick={cycle}
          disabled={!editor.isEditable}
          className={cn(
            "relative mt-px flex flex-none items-center gap-1.5 rounded-[3px] border bg-editor px-1.5 py-0.5 font-mono text-[11px] font-medium outline-none transition-[background-color,scale] duration-150 ease-out after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]",
            meta.className,
            meta.border
          )}
          aria-label={`Acceptance status: ${meta.label}. Click to change.`}
        >
          <span className="relative size-3">
            {STATUSES.map((candidate) => {
              const StatusIcon = STATUS_META[candidate].icon
              const active = candidate === status
              return (
                <StatusIcon
                  key={candidate}
                  className={cn(
                    "absolute inset-0 size-3 transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
                    active
                      ? "scale-100 opacity-100 blur-0"
                      : "scale-[0.25] opacity-0 blur-[4px]"
                  )}
                />
              )
            })}
          </span>
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
