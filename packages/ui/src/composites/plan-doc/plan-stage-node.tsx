import { mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer
} from "@tiptap/react"
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Network,
  RefreshCw,
  Square
} from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/button.js"
import { cn } from "../../lib/cn.js"
import { usePlanWorkerControls } from "./plan-worker-controls.js"

/**
 * `<section data-stage="01" data-title="…">…children…</section>` — a plan stage.
 *
 * The stage is a block container (`content: "block+"`) so its body (intent,
 * approach, acceptance criteria, annotations) is ordinary editable document
 * content. `parseHTML`/`renderHTML` round-trip the two data-attributes the HTML
 * plan engine (`@jingler/core` `plan-html.ts`) reads back, so what the editor
 * emits re-parses to the same PlanPrd projection.
 */

const splitDependencies = (value: string): ReadonlyArray<string> =>
  value.split(/[\s,]+/).filter((dependency) => dependency.length > 0)

function StageView({ node }: NodeViewProps) {
  const [open, setOpen] = useState(true)
  const id = (node.attrs.id as string) || "—"
  const title = (node.attrs.title as string) || "Untitled stage"
  const complexity = (node.attrs.complexity as string) || "medium"
  const dependencies = splitDependencies((node.attrs.dependencies as string) || "")
  return (
    <NodeViewWrapper
      data-plan-stage-id={id}
      data-plan-stage-title={title}
      className="my-4 overflow-hidden rounded-md border border-line"
    >
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
        {dependencies.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line-strong bg-editor px-1.5 py-0.5 text-dim"
            title={`Depends on ${dependencies.join(", ")}`}
          >
            <Network className="size-3" />
            {dependencies.join(", ")}
          </span>
        )}
        <span className="shrink-0 rounded-[3px] border border-line-strong bg-editor px-1.5 py-0.5 uppercase text-muted">
          {complexity}
        </span>
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
      },
      dependencies: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-depends-on") ?? "",
        renderHTML: (attrs) => ({ "data-depends-on": attrs.dependencies })
      },
      complexity: {
        default: "medium",
        parseHTML: (el) => el.getAttribute("data-complexity") ?? "medium",
        renderHTML: (attrs) => ({ "data-complexity": attrs.complexity })
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

const STATUS_TONE: Readonly<Record<string, string>> = {
  queued: "text-muted",
  running: "text-blue",
  blocked: "text-yellow",
  failed: "text-red",
  interrupted: "text-orange",
  completed: "text-green"
}

/**
 * A provider-neutral assignment is a first-class, atom-like block so Tiptap
 * preserves it exactly while exposing readable orchestration metadata.
 */
function AssignmentView({ node }: NodeViewProps) {
  const agentId = (node.attrs.agentId as string) || "Unassigned"
  const cli = (node.attrs.cli as string) || "unknown harness"
  const model = (node.attrs.model as string) || "unknown model"
  const reason = (node.attrs.reason as string) || "No routing reason provided."
  const status = (node.attrs.status as string) || "queued"
  const controls = usePlanWorkerControls()
  const stoppable = status === "running" && controls.stop !== undefined
  const retryable =
    (status === "blocked" ||
      status === "failed" ||
      status === "interrupted") &&
    controls.retry !== undefined
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-2 flex items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[11px]"
      data-plan-assignment-card="true"
    >
      <Bot className="mt-0.5 size-3.5 shrink-0 text-purple" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="text-text-bright">{agentId}</strong>
          <span className="text-text-body">{cli} · {model}</span>
          <span className={cn("uppercase", STATUS_TONE[status] ?? "text-muted")}>{status}</span>
        </span>
        <span className="mt-0.5 block text-muted">{reason}</span>
      </span>
      {stoppable && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={`Stop worker ${agentId}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controls.stop?.(agentId)}
          className="shrink-0 rounded-md text-muted hover:text-text-bright"
        >
          <Square className="size-3" />
        </Button>
      )}
      {retryable && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={`Retry worker ${agentId}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controls.retry?.(agentId)}
          className="shrink-0 rounded-md text-muted hover:text-text-bright"
        >
          <RefreshCw className="size-3" />
        </Button>
      )}
    </NodeViewWrapper>
  )
}

export const PlanAssignmentNode = Node.create({
  name: "planAssignment",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      assignment: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-assignment") ?? "",
        renderHTML: () => ({ "data-assignment": "" })
      },
      agentId: {
        default: "",
        parseHTML: (el) =>
          el.getAttribute("data-agent-id") ?? el.getAttribute("data-assignment") ?? "",
        renderHTML: (attrs) => ({ "data-agent-id": attrs.agentId })
      },
      cli: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-cli") ?? "",
        renderHTML: (attrs) => ({ "data-cli": attrs.cli })
      },
      model: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-model") ?? "",
        renderHTML: (attrs) => ({ "data-model": attrs.model })
      },
      reason: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-reason") ?? "",
        renderHTML: (attrs) => ({ "data-reason": attrs.reason })
      },
      status: {
        default: "queued",
        parseHTML: (el) => el.getAttribute("data-status") ?? "queued",
        renderHTML: (attrs) => ({ "data-status": attrs.status })
      }
    }
  },

  parseHTML() {
    return [{ tag: "div[data-assignment]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssignmentView)
  }
})
