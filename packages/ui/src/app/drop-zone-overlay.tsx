import { cn } from "../lib/cn.js"
import type { DropEdge } from "./editor-layout.js"

/** Share of the group's width/height, from each side, that splits instead of moving. */
const EDGE_BAND = 0.25

interface DropRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Pointer position → drop zone: the nearest side within the outer quarter,
 * else the middle. Ties (a corner diagonal) go left, right, top, bottom.
 */
export const resolveDropEdge = (rect: DropRect, clientX: number, clientY: number): DropEdge => {
  if (rect.width === 0 || rect.height === 0) return "center"
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  const sides: ReadonlyArray<readonly [DropEdge, number]> = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]]
  const [edge, distance] = sides.reduce((best, next) => (next[1] < best[1] ? next : best))
  return distance < EDGE_BAND ? edge : "center"
}

const NEAR = EDGE_BAND * 100
const FAR = 100 - NEAR
// Percent polygons of the group box; they tile it exactly as `resolveDropEdge` does.
const ZONES: ReadonlyArray<{ edge: DropEdge; label: string; points: string; labelClass: string }> = [
  { edge: "left", label: "Split left", points: `0,0 ${NEAR},${NEAR} ${NEAR},${FAR} 0,100`, labelClass: "left-2 top-1/2 -translate-y-1/2" },
  { edge: "right", label: "Split right", points: `100,0 100,100 ${FAR},${FAR} ${FAR},${NEAR}`, labelClass: "right-2 top-1/2 -translate-y-1/2" },
  { edge: "top", label: "Split up", points: `0,0 100,0 ${FAR},${NEAR} ${NEAR},${NEAR}`, labelClass: "left-1/2 top-2 -translate-x-1/2" },
  { edge: "bottom", label: "Split down", points: `0,100 ${NEAR},${FAR} ${FAR},${FAR} 100,100`, labelClass: "bottom-2 left-1/2 -translate-x-1/2" },
  { edge: "center", label: "Move here", points: `${NEAR},${NEAR} ${FAR},${NEAR} ${FAR},${FAR} ${NEAR},${FAR}`, labelClass: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" }
]

/**
 * Drag-to-split overlay for one editor group: five labelled zones in the brand
 * tint, the hovered one filled and outlined. `zones={false}` is the single
 * "move here" wash used over a tab strip. Never takes pointer events.
 */
export function DropZoneOverlay({ edge, rejected = false, zones = true }: {
  edge: DropEdge
  rejected?: boolean
  zones?: boolean
}) {
  const container = "pointer-events-none absolute inset-0 z-20"
  if (!zones) {
    return (
      <div
        data-testid="editor-drop-overlay"
        data-edge={edge}
        aria-hidden
        className={cn(container, "bg-brand/15 ring-2 ring-inset ring-brand")}
      />
    )
  }
  return (
    <div
      data-testid="editor-drop-overlay"
      data-edge={edge}
      data-rejected={rejected || undefined}
      aria-hidden
      className={cn(container, rejected && "ring-2 ring-inset ring-red")}
    >
      {ZONES.map((zone) => {
        const active = zone.edge === edge
        return (
          <div key={zone.edge} data-testid="editor-drop-zone" data-zone={zone.edge} data-active={active} className="absolute inset-0">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full">
              <polygon
                points={zone.points}
                strokeWidth={1}
                className={cn(
                  "[vector-effect:non-scaling-stroke]",
                  active
                    ? rejected ? "fill-red/20 stroke-red" : "fill-brand/20 stroke-brand"
                    : "fill-brand/5 stroke-brand/30"
                )}
              />
            </svg>
            <span
              className={cn(
                "absolute whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
                zone.labelClass,
                active ? "bg-panel text-text-bright" : "text-muted-foreground"
              )}
            >
              {zone.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
