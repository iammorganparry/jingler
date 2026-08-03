import type {
  MemoryGraphEdge,
  MemoryGraphEdgeKind,
  MemoryGraphNode
} from "@jingler/contracts"
import { useEffect, useMemo, useRef, useState } from "react"
import ForceGraph3D from "react-force-graph-3d"
import type {
  ForceGraphMethods,
  LinkObject,
  NodeObject
} from "react-force-graph-3d"
import SpriteText from "three-spritetext"
import { Vector3 } from "three"
import type { MemoryViewport } from "./memory-map.js"

// A node/link as handed to the force engine. The engine augments each node with
// live `x/y/z` during simulation, so these objects must stay identity-stable
// across selection changes — otherwise every click would reheat the layout.
interface Node3D {
  readonly id: string
  readonly title: string
  readonly kind: MemoryGraphNode["kind"]
  readonly degree: number
  readonly unhealthy: boolean
  readonly contradicted: boolean
}
interface Link3D {
  readonly id: string
  readonly kind: MemoryGraphEdgeKind
  readonly source: string
  readonly target: string
}

export interface MemoryMap3DProps {
  readonly nodes: ReadonlyArray<MemoryGraphNode>
  readonly edges: ReadonlyArray<MemoryGraphEdge>
  readonly selectedNodeId: string | null
  readonly selectedEdgeId: string | null
  readonly viewport: MemoryViewport
  readonly reducedMotion: boolean
  readonly onSelectNode: (nodeId: string) => void
  readonly onSelectEdge: (edgeId: string) => void
  readonly onExpandNode: (nodeId: string) => void
}

// Node geometry (world units) — every value named so the scene is auditable and
// never a bare literal.
const NODE_REL_SIZE = 5
const NODE_BASE_VAL = 1.4
const NODE_VAL_PER_DEGREE = 1.1
const NODE_SELECTED_SCALE = 1.7
const NODE_RESOLUTION = 16
const LABEL_TEXT_HEIGHT = 3.2
const LABEL_MAX_CHARS = 24
const LABEL_Y_OFFSET = 7

// Link geometry — the directional particles are the "alive" flow along an edge.
const LINK_WIDTH = 0.4
const LINK_WIDTH_SELECTED = 2.5
const LINK_OPACITY = 0.34
const LINK_PARTICLES = 2
const LINK_PARTICLES_SELECTED = 4
const LINK_PARTICLE_WIDTH = 2.2
const LINK_PARTICLE_SPEED = 0.006

// Camera framing (world units / ms). Zoom maps inversely to camera distance.
const BASE_CAMERA_DISTANCE = 320
const MIN_ZOOM = 0.3
const MAX_ZOOM = 3
const FIT_PADDING = 64
const FIT_DURATION_MS = 700
const CAMERA_MOVE_MS = 320
const FOCUS_DISTANCE = 120
// A viewport pan unit is a node-space pixel; scale it into world units so the
// on-screen pan buttons nudge the orbit target a sensible amount.
const PAN_WORLD_SCALE = 0.7
// With reduced motion the simulation must settle fast and hold still.
const REDUCED_MOTION_COOLDOWN_TICKS = 0

// Theme fallbacks — only used if a `--sb-*` token can't be resolved (it always
// can in the app and Storybook); the mapper never hardcodes a live palette.
const FALLBACK = {
  blue: "#61afef",
  cyan: "#56b6c2",
  yellow: "#e5c07b",
  red: "#e06c75",
  line: "#3a3f4b",
  text: "#d7dae0",
  background: "#21252b"
} as const

interface Palette {
  readonly blue: string
  readonly cyan: string
  readonly yellow: string
  readonly red: string
  readonly line: string
  readonly text: string
  readonly background: string
}

const readToken = (style: CSSStyleDeclaration, token: string, fallback: string): string => {
  const value = style.getPropertyValue(token).trim()
  return value === "" ? fallback : value
}

const readPalette = (element: Element): Palette => {
  const style = getComputedStyle(element)
  return {
    blue: readToken(style, "--sb-blue", FALLBACK.blue),
    cyan: readToken(style, "--sb-cyan", FALLBACK.cyan),
    yellow: readToken(style, "--sb-yellow", FALLBACK.yellow),
    red: readToken(style, "--sb-red", FALLBACK.red),
    line: readToken(style, "--sb-line-strong", FALLBACK.line),
    text: readToken(style, "--sb-text", FALLBACK.text),
    background: readToken(style, "--sb-sunken", FALLBACK.background)
  }
}

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

const nodeColor = (node: Node3D, palette: Palette): string => {
  if (node.contradicted) return palette.red
  if (node.unhealthy) return palette.yellow
  return node.kind === "page" ? palette.blue : palette.cyan
}

const nodeVal = (node: Node3D, selected: boolean): number => {
  const base = NODE_BASE_VAL + Math.sqrt(node.degree) * NODE_VAL_PER_DEGREE
  return selected ? base * NODE_SELECTED_SCALE : base
}

export function MemoryMap3D({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  viewport,
  reducedMotion,
  onSelectNode,
  onSelectEdge,
  onExpandNode
}: MemoryMap3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<
    ForceGraphMethods<NodeObject<Node3D>, LinkObject<Node3D, Link3D>> | undefined
  >(undefined)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [palette, setPalette] = useState<Palette>(FALLBACK)
  const previousViewport = useRef(viewport)

  // The engine mutates node objects in place, so build the graph only from the
  // node/edge identity — never from selection — to keep positions stable.
  const graphData = useMemo(() => {
    const known = new Set(nodes.map((node) => node.id))
    return {
      nodes: nodes.map<Node3D>((node) => ({
        id: node.id,
        title: node.title,
        kind: node.kind,
        degree: node.degree.incoming + node.degree.outgoing,
        unhealthy: node.health.orphan || node.health.brokenLinks > 0 || node.health.contradictions > 0,
        contradicted: node.health.contradictions > 0
      })),
      links: edges
        .filter((edge) => known.has(edge.sourceId) && known.has(edge.targetId))
        .map<Link3D>((edge) => ({ id: edge.id, kind: edge.kind, source: edge.sourceId, target: edge.targetId }))
    }
  }, [nodes, edges])

  // Measure the box so the WebGL canvas fills it and tracks resizes.
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Resolve theme tokens on mount and again whenever the active theme swaps
  // (the theme engine rewrites the `:root` custom properties live).
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const refresh = () => setPalette(readPalette(element))
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    observer.observe(document.head, { childList: true })
    return () => observer.disconnect()
  }, [])

  // Frame the whole graph once the layout settles for each new graph.
  const fitToView = () => graphRef.current?.zoomToFit(FIT_DURATION_MS, FIT_PADDING)

  // Map the shared viewport zoom onto camera distance and pan onto the orbit
  // target, without fighting the rotation the user set by dragging.
  useEffect(() => {
    const graph = graphRef.current
    if (graph === undefined) return
    const previous = previousViewport.current
    previousViewport.current = viewport
    const controls = graph.controls() as unknown as { target?: Vector3; update?: () => void }
    const target = controls.target
    if (target === undefined) return
    const camera = graph.camera()
    const eye = new Vector3(camera.position.x, camera.position.y, camera.position.z)
    const offset = eye.clone().sub(target)

    const panX = (viewport.x - previous.x) * PAN_WORLD_SCALE
    const panY = (viewport.y - previous.y) * PAN_WORLD_SCALE
    if (panX !== 0 || panY !== 0) {
      const right = new Vector3().setFromMatrixColumn(camera.matrix, 0)
      const up = new Vector3().setFromMatrixColumn(camera.matrix, 1)
      const shift = right.multiplyScalar(panX).add(up.multiplyScalar(panY))
      target.add(shift)
      eye.add(shift)
    }

    const distance = BASE_CAMERA_DISTANCE / clampZoom(viewport.zoom)
    const scaled = offset.setLength(distance)
    const position = target.clone().add(scaled)
    graph.cameraPosition({ x: position.x, y: position.y, z: position.z }, target, CAMERA_MOVE_MS)
  }, [viewport])

  const focusNode = (node: NodeObject<Node3D>) => {
    const graph = graphRef.current
    if (graph === undefined || node.x === undefined || node.y === undefined || node.z === undefined) return
    const target = new Vector3(node.x, node.y, node.z)
    const ratio = 1 + FOCUS_DISTANCE / Math.max(FOCUS_DISTANCE, Math.hypot(node.x, node.y, node.z))
    graph.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      target,
      CAMERA_MOVE_MS
    )
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph3D<Node3D, Link3D>
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        backgroundColor={palette.background}
        showNavInfo={false}
        nodeRelSize={NODE_REL_SIZE}
        nodeResolution={NODE_RESOLUTION}
        nodeColor={(node) => nodeColor(node, palette)}
        nodeVal={(node) => nodeVal(node, node.id === selectedNodeId)}
        nodeLabel={(node) => node.title}
        nodeThreeObjectExtend={true}
        nodeThreeObject={(node) => {
          const sprite = new SpriteText(node.title.slice(0, LABEL_MAX_CHARS), LABEL_TEXT_HEIGHT, palette.text)
          sprite.position.set(0, LABEL_Y_OFFSET, 0)
          sprite.material.depthWrite = false
          return sprite
        }}
        linkColor={(link) => (link.id === selectedEdgeId ? palette.blue : palette.line)}
        linkWidth={(link) => (link.id === selectedEdgeId ? LINK_WIDTH_SELECTED : LINK_WIDTH)}
        linkOpacity={LINK_OPACITY}
        linkDirectionalParticles={(link) =>
          reducedMotion ? 0 : link.id === selectedEdgeId ? LINK_PARTICLES_SELECTED : LINK_PARTICLES
        }
        linkDirectionalParticleWidth={LINK_PARTICLE_WIDTH}
        linkDirectionalParticleSpeed={LINK_PARTICLE_SPEED}
        linkDirectionalParticleColor={(link) => (link.id === selectedEdgeId ? palette.blue : palette.cyan)}
        cooldownTicks={reducedMotion ? REDUCED_MOTION_COOLDOWN_TICKS : undefined}
        onEngineStop={fitToView}
        onNodeClick={(node) => {
          onSelectNode(node.id)
          focusNode(node)
        }}
        onNodeRightClick={(node) => onExpandNode(node.id)}
        onLinkClick={(link: LinkObject<Node3D, Link3D>) => {
          if (typeof link.id === "string") onSelectEdge(link.id)
        }}
      />
    </div>
  )
}

export default MemoryMap3D
