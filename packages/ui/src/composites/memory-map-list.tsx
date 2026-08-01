import type { MemoryGraphEdge, MemoryGraphNode } from "@jingler/contracts"
import { ArrowRight, CircleDot, FileText } from "lucide-react"
import { cn } from "../lib/cn.js"

export interface MemoryMapListProps {
  nodes: ReadonlyArray<MemoryGraphNode>
  edges: ReadonlyArray<MemoryGraphEdge>
  selectedNodeId: string | null
  selectedEdgeId: string | null
  onSelectNode: (nodeId: string) => void
  onSelectEdge: (edgeId: string) => void
}

export function MemoryMapList({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge
}: MemoryMapListProps) {
  return (
    <div className="min-h-0 overflow-auto" data-testid="memory-map-list">
      <h2 className="sticky top-0 z-10 m-0 border-b border-hairline bg-panel px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        Nodes ({nodes.length})
      </h2>
      <ul className="m-0 list-none p-0" aria-label="Memory graph nodes">
        {nodes.map((node) => {
          const degree = node.degree.incoming + node.degree.outgoing
          return (
            <li key={node.id}>
            <button
              type="button"
              data-testid={`memory-node-${node.id}`}
              aria-pressed={selectedNodeId === node.id}
              onClick={() => onSelectNode(node.id)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-hairline px-3 py-2.5 text-left outline-none hover:bg-surface/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selectedNodeId === node.id && "bg-surface"
              )}
            >
              {node.kind === "page" ? <FileText size={13} className="text-blue" /> : <CircleDot size={13} className="text-cyan" />}
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-[11.5px] font-medium text-text">{node.title}</strong>
                <span className="mt-0.5 block truncate font-mono text-[9.5px] text-dim">{node.kind} · {degree} connections · {node.freshness}</span>
              </span>
              {(node.health.orphan || node.health.brokenLinks > 0 || node.health.contradictions > 0) && (
                <span className="rounded border border-yellow/50 px-1.5 py-0.5 text-[9px] text-yellow">Finding</span>
              )}
            </button>
            </li>
          )
        })}
      </ul>

      <h2 className="sticky top-0 z-10 m-0 border-y border-hairline bg-panel px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        Explicit relationships ({edges.length})
      </h2>
      <ul className="m-0 list-none p-0" aria-label="Memory graph relationships">
        {edges.map((edge) => (
          <li key={edge.id}>
          <button
            type="button"
            data-testid={`memory-edge-${edge.id}`}
            aria-pressed={selectedEdgeId === edge.id}
            onClick={() => onSelectEdge(edge.id)}
            className={cn(
              "flex w-full items-center gap-2 border-b border-hairline px-3 py-2 text-left outline-none hover:bg-surface/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selectedEdgeId === edge.id && "bg-surface"
            )}
          >
            <span className="truncate font-mono text-[9.5px] text-muted-foreground">{edge.sourceId}</span>
            <ArrowRight size={11} className="flex-none text-dim" />
            <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-muted-foreground">{edge.targetId}</span>
            <span className="rounded bg-sunken px-1.5 py-0.5 text-[9px] text-text">{edge.kind}</span>
          </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
