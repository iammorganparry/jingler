import "@xyflow/react/dist/style.css"
import { useMemo } from "react"
import type {
  PlanPrd,
  PlanStageComplexity,
  PlanStageExecutionStatus,
  PlanWorkflowGraph,
  PlanWorkflowNode
} from "@jingler/core"
import { stagesToGraph } from "@jingler/core"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider
} from "@xyflow/react"
import { RotateCcw, Square, Waypoints } from "lucide-react"
import { cn } from "../lib/cn.js"
import { layoutDagre } from "./flow-layout.js"

const NODE_W = 208
const NODE_H = 64

/**
 * Per execution-status visual treatment. Every value is a `--sb-*`-backed
 * Tailwind token (never a literal hex), so the whole workflow re-colours with
 * the active theme. `pulse` marks the live/attention states (running, blocked)
 * whose dot animates so an executing plan reads at a glance.
 */
const STATUS_STYLE: Record<
  PlanStageExecutionStatus,
  { ring: string; dot: string; text: string; label: string; pulse: boolean }
> = {
  queued: { ring: "border-line", dot: "bg-dim", text: "text-dim", label: "Queued", pulse: false },
  running: { ring: "border-blue/55", dot: "bg-blue", text: "text-blue", label: "Running", pulse: true },
  blocked: {
    ring: "border-yellow/55",
    dot: "bg-yellow",
    text: "text-yellow",
    label: "Blocked",
    pulse: true
  },
  failed: { ring: "border-red/55", dot: "bg-red", text: "text-red", label: "Failed", pulse: false },
  interrupted: {
    ring: "border-orange/55",
    dot: "bg-orange",
    text: "text-orange",
    label: "Interrupted",
    pulse: false
  },
  completed: {
    ring: "border-green/50",
    dot: "bg-green",
    text: "text-green",
    label: "Completed",
    pulse: false
  }
}

/** Complexity badge tone — a quiet planner hint, distinct from the status accent. */
const COMPLEXITY_TEXT: Record<PlanStageComplexity, string> = {
  low: "text-muted-foreground",
  medium: "text-cyan",
  high: "text-purple"
}

interface NodeData extends Record<string, unknown> {
  readonly node: PlanWorkflowNode
  readonly selected: boolean
  readonly onStop?: (agentId: string) => void
  readonly onRetry?: (agentId: string) => void
}

/** Statuses whose owning worker can be halted / re-run straight from the node. */
const STOPPABLE: ReadonlySet<PlanStageExecutionStatus> = new Set(["running", "blocked"])
const RETRYABLE: ReadonlySet<PlanStageExecutionStatus> = new Set(["failed", "interrupted"])

/** One stage as a workflow node: status accent + title + complexity chip. */
function WorkflowNode({ data }: NodeProps<Node<NodeData>>) {
  const { node, selected, onStop, onRetry } = data
  const status = STATUS_STYLE[node.executionStatus]
  const agentId = node.agentId
  const canStop = agentId !== null && STOPPABLE.has(node.executionStatus) && onStop !== undefined
  const canRetry = agentId !== null && RETRYABLE.has(node.executionStatus) && onRetry !== undefined
  return (
    <div
      style={{ width: NODE_W, minHeight: NODE_H }}
      className={cn(
        "flex cursor-pointer flex-col justify-center gap-1 rounded-lg border bg-panel px-3 py-2 shadow-sm transition-colors",
        selected ? "border-blue bg-blue/10 ring-1 ring-blue/40" : status.ring
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-line-strong" />
      <div className="flex items-center gap-1.5">
        <span
          className={cn("size-1.5 flex-none rounded-full", status.dot, status.pulse && "animate-pulse")}
        />
        <span className={cn("truncate text-[9px] font-semibold uppercase tracking-[0.4px]", status.text)}>
          {status.label}
        </span>
        {node.complexity && (
          <span
            className={cn(
              "ml-auto flex-none rounded-full border border-hairline px-1.5 text-[8.5px] font-semibold uppercase tracking-[0.4px]",
              COMPLEXITY_TEXT[node.complexity]
            )}
          >
            {node.complexity}
          </span>
        )}
      </div>
      <span className="truncate text-[12px] font-medium text-text">{node.title}</span>
      {(canStop || canRetry) && (
        // `nodrag nopan` so a tap on the control acts, not pans the canvas; the
        // click also stops propagating so it doesn't double as a node-select.
        <div className="nodrag nopan mt-0.5 flex items-center gap-1.5">
          {node.worker && (
            <span className="min-w-0 flex-1 truncate font-mono text-[8.5px] text-muted-foreground">
              {node.worker}
            </span>
          )}
          {canStop && (
            <button
              type="button"
              title="Stop worker"
              aria-label={`Stop worker ${agentId}`}
              onClick={(event) => {
                event.stopPropagation()
                onStop?.(agentId as string)
              }}
              className="flex size-5 flex-none items-center justify-center rounded border border-red/40 text-red transition-colors hover:bg-red/10"
            >
              <Square size={10} />
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              title="Retry worker"
              aria-label={`Retry worker ${agentId}`}
              onClick={(event) => {
                event.stopPropagation()
                onRetry?.(agentId as string)
              }}
              className="flex size-5 flex-none items-center justify-center rounded border border-blue/40 text-blue transition-colors hover:bg-blue/10"
            >
              <RotateCcw size={10} />
            </button>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-line-strong" />
    </div>
  )
}

const nodeTypes = { workflowNode: WorkflowNode }

/** Lay the dependency graph out top-down; returns react-flow nodes + edges. */
const layout = (graph: PlanWorkflowGraph) => {
  const positions = layoutDagre(graph.nodes, graph.edges, { nodeWidth: NODE_W, nodeHeight: NODE_H })

  const nodes: Array<Node<NodeData>> = graph.nodes.map((node) => ({
    id: node.id,
    type: "workflowNode",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: { node, selected: false }
  }))

  const edges = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: "smoothstep",
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
  }))

  return { nodes, edges }
}

/**
 * The plan's execution DAG on a navigable react-flow canvas: one node per stage,
 * coloured by its live `executionStatus`, wired by dependency edges. Clicking a
 * node calls `onSelectStage`; `selectedStageId` reflects back as a highlighted
 * node — the cross-link the Main page and nav shell use to keep the workflow and
 * the step detail in sync. Pan / zoom / fit; nodes are not connectable.
 */
export function PlanWorkflow({
  prd,
  selectedStageId,
  onSelectStage,
  onStopWorker,
  onRetryWorker,
  className
}: {
  /** The canonical plan; its stages + dependencies become the graph. */
  prd: PlanPrd
  /** The selected STAGE id (highlights its node). */
  selectedStageId?: string | null
  /** Called with a node's stage id when clicked. */
  onSelectStage?: (stageId: string) => void
  /** Halt the worker owning a running/blocked stage, straight from its node. */
  onStopWorker?: (agentId: string) => void
  /** Re-run the worker owning a failed/interrupted stage, straight from its node. */
  onRetryWorker?: (agentId: string) => void
  className?: string
}) {
  const graph = useMemo(() => stagesToGraph(prd), [prd])
  // Dagre runs once per graph. Selection and the worker handlers are injected in
  // a separate, cheap pass so highlighting or re-wiring a node never re-lays-out.
  const laidOut = useMemo(() => layout(graph), [graph])
  const nodes = useMemo(
    () =>
      laidOut.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          selected: n.data.node.stageId === selectedStageId,
          onStop: onStopWorker,
          onRetry: onRetryWorker
        }
      })),
    [laidOut, selectedStageId, onStopWorker, onRetryWorker]
  )
  const edges = laidOut.edges

  if (graph.nodes.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center",
          className
        )}
      >
        <Waypoints className="size-8 text-line-strong" />
        <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
          This plan has no stages yet. Once the planner lays out the work, each stage shows up here as
          a node in the dependency graph.
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-editor", className)}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          edgesFocusable={false}
          onNodeClick={(_, node) => onSelectStage?.((node.data as NodeData).node.stageId)}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="!bg-editor" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeStrokeWidth={2} className="!bg-panel" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
