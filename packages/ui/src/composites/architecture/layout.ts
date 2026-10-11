import type { ArchitectureShape, PlanArchitectureBlock } from "@jingler/core"

export type Point3 = readonly [number, number, number]
export type Flat = readonly [number, number]

type Component = PlanArchitectureBlock["components"][number]
type Layer = PlanArchitectureBlock["layers"][number]
type Link = PlanArchitectureBlock["links"][number]

// Fixed dimetric camera: azimuth 45°, elevation 30°. x runs right, y runs toward the viewer, z up.
const SIN_A = Math.SQRT1_2
const COS_A = Math.SQRT1_2
const SIN_E = 0.5
const COS_E = Math.sqrt(3) / 2

export const iso = ([x, y, z]: Point3): Flat => [x * SIN_A - y * COS_A, (x * COS_A + y * SIN_A) * SIN_E - z * COS_E]
/** Larger is nearer the viewer; paint ascending. */
export const depthOf = ([x, y, z]: Point3): number => (x * COS_A + y * SIN_A) * COS_E + z * SIN_E

export const CELL = 96
export const PLINTH = { depth: 104, height: 16, margin: 28, gap: 46 } as const
export const MAX_COLUMNS = 6
export const PEDESTAL = { width: 80, depth: 72, height: 12 } as const

/** Bounding size [width, depth, height] of each part recipe. */
export const PART_SIZE: Record<ArchitectureShape, Point3> = {
  client: [52, 40, 26],
  gateway: [60, 30, 42],
  service: [52, 52, 34],
  worker: [48, 48, 30],
  queue: [68, 36, 16],
  store: [48, 48, 38],
  cache: [52, 44, 30],
  external: [50, 50, 28]
}

export interface PlacedLayer {
  readonly layer: Layer
  readonly origin: Point3
  readonly size: Point3
}
export interface PlacedPart {
  readonly component: Component
  /** Pedestal origin; the part sits centred on top of it. */
  readonly pedestal: Point3
  readonly origin: Point3
  readonly size: Point3
  /** Top-centre terminal every wire ends on. */
  readonly port: Point3
  readonly depth: number
}
export interface PlacedWire {
  readonly link: Link
  readonly index: number
  readonly points: ReadonlyArray<Point3>
}
export interface ArchitectureLayout {
  readonly layers: ReadonlyArray<PlacedLayer>
  readonly parts: ReadonlyArray<PlacedPart>
  readonly wires: ReadonlyArray<PlacedWire>
  readonly viewBox: string
}

export function layoutArchitecture(block: PlanArchitectureBlock): ArchitectureLayout {
  const members = block.layers.map((layer) => block.components.filter((c) => c.layer === layer.id))
  // Wrap each layer into rows of at most MAX_COLUMNS so dense layers grow deeper, not wider.
  const rowCounts = members.map((row) => Math.max(Math.ceil(row.length / MAX_COLUMNS), 1))
  const columns = Math.min(Math.max(...members.map((row) => row.length), 1), MAX_COLUMNS)
  const width = columns * CELL + PLINTH.margin * 2
  const layerY = rowCounts.map((_, index) =>
    rowCounts.slice(0, index).reduce((sum, rows) => sum + rows * PLINTH.depth + PLINTH.gap, 0)
  )

  const layers = block.layers.map((layer, index): PlacedLayer => ({
    layer,
    origin: [0, layerY[index]!, -PLINTH.height],
    size: [width, rowCounts[index]! * PLINTH.depth, PLINTH.height]
  }))

  const parts = members
    .flatMap((members, layerIndex) =>
      members.map((component, position): PlacedPart => {
        const row = Math.floor(position / MAX_COLUMNS)
        const column = position % MAX_COLUMNS
        const inRow = Math.min(members.length - row * MAX_COLUMNS, MAX_COLUMNS)
        const start = PLINTH.margin + ((columns - inRow) * CELL) / 2
        const y = layerY[layerIndex]! + row * PLINTH.depth + (PLINTH.depth - PEDESTAL.depth) / 2
        const cx = start + column * CELL + CELL / 2
        const cy = y + PEDESTAL.depth / 2
        const size = PART_SIZE[component.shape]
        const origin: Point3 = [cx - size[0] / 2, cy - size[1] / 2, PEDESTAL.height]
        return {
          component,
          pedestal: [cx - PEDESTAL.width / 2, y, 0],
          origin,
          size,
          port: [cx, cy, PEDESTAL.height + size[2]],
          depth: depthOf([cx, cy, 0])
        }
      })
    )
    .sort((a, b) => a.depth - b.depth)

  const byId = new Map(parts.map((part) => [part.component.id, part]))
  const tray = PEDESTAL.height + Math.max(...parts.map(({ size }) => size[2])) + 18
  const wires = block.links.flatMap((link, index): PlacedWire[] => {
    const from = byId.get(link.from)?.port
    const to = byId.get(link.to)?.port
    if (from === undefined || to === undefined) return []
    // Overhead cable tray: rise, run along x, then along y, drop onto the target port.
    const z = tray + (index % 6) * 5
    return [{ link, index, points: [from, [from[0], from[1], z], [to[0], from[1], z], [to[0], to[1], z], to] }]
  })

  const corners = [
    ...layers.flatMap(({ origin, size }) => boxCorners(origin, size)),
    ...parts.flatMap(({ origin, size }) => boxCorners(origin, size)),
    ...wires.flatMap(({ points }) => points)
  ].map(iso)
  const xs = corners.map(([x]) => x)
  const ys = corners.map(([, y]) => y)
  const pad = 16
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const viewBox = [minX, minY, Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY].map(round).join(" ")

  return { layers, parts, wires, viewBox }
}

const round = (n: number) => Math.round(n * 10) / 10

const boxCorners = ([x, y, z]: Point3, [w, d, h]: Point3): Point3[] => [
  [x, y, z], [x + w, y, z], [x, y + d, z], [x + w, y + d, z],
  [x, y, z + h], [x + w, y, z + h], [x, y + d, z + h], [x + w, y + d, z + h]
]

export const path = (points: ReadonlyArray<Point3>, closed = true): string =>
  points.map((p, i) => `${i === 0 ? "M" : "L"}${iso(p).map(round).join(" ")}`).join(" ") + (closed ? " Z" : "")

/** The three faces a 45° camera sees: top, front (+y) and side (+x). */
export const box = ([x, y, z]: Point3, [w, d, h]: Point3) => ({
  top: path([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]]),
  front: path([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]]),
  side: path([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])
})

/** Upright cylinder: circles project to axis-aligned ellipses (rx = r, ry = r·sinE). */
export const cylinder = ([cx, cy]: Flat, r: number, z0: number, z1: number) => {
  const [bx, by] = iso([cx, cy, z0])
  const [tx, ty] = iso([cx, cy, z1])
  const ry = round(r * SIN_E)
  const f = (n: number) => round(n)
  return {
    body: `M${f(tx - r)} ${f(ty)} L${f(bx - r)} ${f(by)} A${r} ${ry} 0 0 0 ${f(bx + r)} ${f(by)} L${f(tx + r)} ${f(ty)} A${r} ${ry} 0 0 0 ${f(tx - r)} ${f(ty)} Z`,
    top: { cx: tx, cy: ty, rx: r, ry }
  }
}

/** SVG transform that lays text flat on a +y (front) face, starting at `at`. */
export const frontFaceText = (at: Point3): string => {
  const [x, y] = iso(at).map(round)
  return `matrix(${round(SIN_A * 1000) / 1000} ${round(COS_A * SIN_E * 1000) / 1000} 0 ${round(COS_E * 1000) / 1000} ${x} ${y})`
}
