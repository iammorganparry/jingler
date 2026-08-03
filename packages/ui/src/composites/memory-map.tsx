import type {
  MemoryGraphEdgeKind,
  MemoryGraphNode,
  MemoryGraphView
} from "@jingler/contracts"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eye,
  Filter,
  Focus,
  RotateCcw,
  ZoomIn,
  ZoomOut
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { MemoryMapList } from "./memory-map-list.js"

// The WebGL layer pulls in three.js; lazy-load it so it never enters a
// non-WebGL environment (jsdom under Vitest) and never bloats first paint.
const MemoryMap3D = lazy(() => import("./memory-map-3d.js"))

export interface MemoryNodePosition {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface MemoryViewport {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface MemoryMapFilters {
  readonly query: string
  readonly topic: string | null
  readonly relationship: MemoryGraphEdgeKind | null
  readonly freshness: "fresh" | "aging" | "stale" | "unknown" | null
  readonly healthOnly: boolean
  readonly showIsolated: boolean
}

export interface MemoryMapProps {
  graph: MemoryGraphView | null
  positions: ReadonlyArray<MemoryNodePosition>
  filters: MemoryMapFilters
  viewport: MemoryViewport
  selectedNodeId: string | null
  selectedEdgeId: string | null
  loading?: boolean
  onSelectNode: (nodeId: string) => void
  onSelectEdge: (edgeId: string) => void
  onExpandNode: (nodeId: string) => void
  onViewportChange: (viewport: MemoryViewport) => void
  onFiltersChange: (filters: MemoryMapFilters) => void
}

const unhealthy = (node: MemoryGraphNode): boolean =>
  node.health.orphan || node.health.brokenLinks > 0 || node.health.contradictions > 0

/**
 * Build a valid `ctx.font` string from the resolved `--sb-font-mono` family.
 * A CSS `var(...)` reference is invalid in the canvas font shorthand, so the
 * concrete family must be interpolated; when it can't be resolved (jsdom, or a
 * theme without the token) fall back to the generic `monospace` keyword.
 */
export const memoryLabelFont = (monoFamily: string): string => {
  const family = monoFamily.trim()
  return family === "" ? "11px monospace" : `11px ${family}`
}

const relationshipFrom = (value: string): MemoryGraphEdgeKind | null => {
  switch (value) {
    case "wikilink":
    case "citation":
    case "dependency":
    case "backlink":
    case "schema":
      return value
    default:
      return null
  }
}

const freshnessFrom = (
  value: string
): MemoryMapFilters["freshness"] => {
  switch (value) {
    case "fresh":
    case "aging":
    case "stale":
    case "unknown":
      return value
    default:
      return null
  }
}

export function MemoryMap({
  graph,
  positions,
  filters,
  viewport,
  selectedNodeId,
  selectedEdgeId,
  loading = false,
  onSelectNode,
  onSelectEdge,
  onExpandNode,
  onViewportChange,
  onFiltersChange
}: MemoryMapProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 })
  const [webglAvailable, setWebglAvailable] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const positionById = useMemo(() => new Map(positions.map((position) => [position.id, position])), [positions])
  const nodes = useMemo(() => {
    if (graph === null) return []
    const query = filters.query.trim().toLocaleLowerCase()
    return graph.nodes.filter((node) => {
      if (query && !`${node.title} ${node.id}`.toLocaleLowerCase().includes(query)) return false
      if (filters.topic && node.topicId !== filters.topic) return false
      if (filters.freshness && node.freshness !== filters.freshness) return false
      if (filters.healthOnly && !unhealthy(node)) return false
      if (!filters.showIsolated && node.health.orphan) return false
      return true
    })
  }, [filters, graph])
  const visibleIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes])
  const edges = useMemo(
    () =>
      (graph?.edges ?? []).filter(
        (edge) =>
          visibleIds.has(edge.sourceId) &&
          visibleIds.has(edge.targetId) &&
          (filters.relationship === null || edge.kind === filters.relationship)
      ),
    [filters.relationship, graph, visibleIds]
  )
  const selectAndCenter = (nodeId: string) => {
    const position = positionById.get(nodeId)
    if (position !== undefined) {
      onViewportChange({ ...viewport, x: -position.x, y: -position.y })
    }
    onSelectNode(nodeId)
  }
  const fitGraph = () => {
    if (positions.length === 0) {
      onViewportChange({ x: 0, y: 0, zoom: 1 })
      return
    }
    const xs = positions.map((position) => position.x)
    const ys = positions.map((position) => position.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const zoom = Math.min(3, Math.max(0.3, Math.min(frameSize.width / width, frameSize.height / height) * 0.8))
    onViewportChange({ x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, zoom })
  }
  const pan = (x: number, y: number) =>
    onViewportChange({ ...viewport, x: viewport.x + x / viewport.zoom, y: viewport.y + y / viewport.zoom })

  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const resize = () => {
      const rect = frame.getBoundingClientRect()
      setFrameSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // Only mount the WebGL layer where a GL context can actually be created. Under
  // jsdom (Vitest) this stays false, so three.js is never imported and the
  // synchronized lists remain the tested surface.
  useEffect(() => {
    try {
      const probe = document.createElement("canvas")
      const gl = probe.getContext("webgl2") ?? probe.getContext("webgl")
      setWebglAvailable(gl !== null)
    } catch {
      setWebglAvailable(false)
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const apply = () => setReducedMotion(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  if (graph === null) {
    return <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">{loading ? "Loading bounded graph…" : "No graph data."}</div>
  }

  return (
    <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]" aria-label="Memory map">
      <div ref={frameRef} className="relative min-h-0 overflow-hidden border-r border-hairline bg-sunken">
        <div
          role="img"
          aria-label="Interactive 3D memory graph. Use the synchronized node and relationship lists to explore with a keyboard or screen reader."
          data-testid="memory-map-canvas"
          data-viewport={`${viewport.x},${viewport.y},${viewport.zoom}`}
          className="absolute inset-0"
        >
          {webglAvailable ? (
            <Suspense
              fallback={
                <div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
                  Rendering 3D graph…
                </div>
              }
            >
              <MemoryMap3D
                nodes={nodes}
                edges={edges}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                viewport={viewport}
                reducedMotion={reducedMotion}
                onSelectNode={onSelectNode}
                onSelectEdge={onSelectEdge}
                onExpandNode={onExpandNode}
              />
            </Suspense>
          ) : (
            <div className="flex size-full items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
              3D view unavailable here — explore the graph with the synchronized node and relationship lists.
            </div>
          )}
        </div>
        <div className="absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5 rounded-lg border border-line bg-panel/95 p-1.5 shadow-sm">
          <label className="flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1.5 text-[10.5px] text-muted-foreground">
            <Filter size={12} />
            <span className="sr-only">Filter graph</span>
            <input
              value={filters.query}
              onChange={(event) => onFiltersChange({ ...filters, query: event.currentTarget.value })}
              placeholder="Filter nodes"
              className="w-28 bg-transparent text-text outline-none placeholder:text-dim"
            />
          </label>
          <select aria-label="Relationship filter" value={filters.relationship ?? ""} onChange={(event) => onFiltersChange({ ...filters, relationship: relationshipFrom(event.currentTarget.value) })} className="rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">All relationships</option>
            <option value="wikilink">Wikilinks</option><option value="citation">Citations</option><option value="dependency">Dependencies</option><option value="backlink">Backlinks</option><option value="schema">Schema</option>
          </select>
          <select aria-label="Topic filter" value={filters.topic ?? ""} onChange={(event) => onFiltersChange({ ...filters, topic: event.currentTarget.value || null })} className="rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">All topics</option>
            {graph.clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.label}</option>)}
          </select>
          <select aria-label="Freshness filter" value={filters.freshness ?? ""} onChange={(event) => onFiltersChange({ ...filters, freshness: freshnessFrom(event.currentTarget.value) })} className="rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">All freshness</option><option value="fresh">Fresh</option><option value="aging">Aging</option><option value="stale">Stale</option><option value="unknown">Unknown</option>
          </select>
          <button type="button" aria-pressed={filters.healthOnly} onClick={() => onFiltersChange({ ...filters, healthOnly: !filters.healthOnly })} className="rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">Findings</button>
          <button type="button" aria-pressed={filters.showIsolated} onClick={() => onFiltersChange({ ...filters, showIsolated: !filters.showIsolated })} className="flex items-center gap-1 rounded-md border border-line bg-sunken px-2 py-1.5 text-[10.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring"><Eye size={11} /> Isolated</button>
        </div>
        <div className="absolute bottom-3 left-3 flex gap-1 rounded-lg border border-line bg-panel/95 p-1 shadow-sm">
          <button type="button" aria-label="Pan left" onClick={() => pan(50, 0)} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft size={14} /></button>
          <button type="button" aria-label="Pan up" onClick={() => pan(0, 50)} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowUp size={14} /></button>
          <button type="button" aria-label="Pan down" onClick={() => pan(0, -50)} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowDown size={14} /></button>
          <button type="button" aria-label="Pan right" onClick={() => pan(-50, 0)} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ArrowRight size={14} /></button>
          <button type="button" aria-label="Zoom out" onClick={() => onViewportChange({ ...viewport, zoom: Math.max(0.3, viewport.zoom - 0.2) })} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ZoomOut size={14} /></button>
          <button type="button" aria-label="Fit graph" onClick={fitGraph} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><Focus size={14} /></button>
          <button type="button" aria-label="Reset graph" onClick={() => onViewportChange({ x: 0, y: 0, zoom: 1 })} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><RotateCcw size={14} /></button>
          <button type="button" aria-label="Zoom in" onClick={() => onViewportChange({ ...viewport, zoom: Math.min(3, viewport.zoom + 0.2) })} className="rounded-md p-2 text-muted-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"><ZoomIn size={14} /></button>
        </div>
        <div className="absolute bottom-3 right-3 rounded-lg border border-line bg-panel/95 px-2.5 py-1.5 font-mono text-[9.5px] text-muted-foreground">
          {nodes.length}/{graph.totalNodes} nodes · {edges.length}/{graph.totalEdges} edges {graph.truncated ? "· bounded" : ""}
        </div>
      </div>
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-panel">
        {graph.clusters.length > 0 && (
          <div className="border-b border-hairline p-2">
            <p className="m-0 px-1 pb-1 text-[9.5px] uppercase tracking-[0.1em] text-dim">Topic clusters</p>
            <div className="flex flex-wrap gap-1">
              {graph.clusters.map((cluster) => (
                <button key={cluster.id} type="button" onClick={() => cluster.sampleNodeIds[0] && onExpandNode(cluster.sampleNodeIds[0])} className="rounded-full border border-line bg-sunken px-2 py-1 text-[9.5px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring">{cluster.label} · {cluster.nodeCount}</button>
              ))}
            </div>
          </div>
        )}
        <MemoryMapList nodes={nodes} edges={edges} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} onSelectNode={selectAndCenter} onSelectEdge={onSelectEdge} />
      </div>
    </section>
  )
}
