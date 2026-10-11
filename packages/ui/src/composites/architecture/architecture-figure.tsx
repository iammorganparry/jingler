import type { PlanArchitectureBlock } from "@jingler/core"
import { type ReactNode, useState } from "react"
import { cn } from "../../lib/cn.js"
import { box, cylinder, frontFaceText, iso, layoutArchitecture, path, PEDESTAL, type PlacedPart, type Point3 } from "./layout.js"

const Box = ({ at, size }: { readonly at: Point3; readonly size: Point3 }) => {
  const faces = box(at, size)
  return (
    <>
      <path className="sb-arch-side" d={faces.side} />
      <path className="sb-arch-front" d={faces.front} />
      <path className="sb-arch-top" d={faces.top} />
    </>
  )
}

const Drum = ({ at, r, z0, z1 }: { readonly at: readonly [number, number]; readonly r: number; readonly z0: number; readonly z1: number }) => {
  const { body, top } = cylinder(at, r, z0, z1)
  return (
    <>
      <path className="sb-arch-front" d={body} />
      <ellipse className="sb-arch-top" {...top} />
    </>
  )
}

/** Horizontal grooves across a +y face: vents, drawer fronts, platter seams. */
const Grooves = ({ at: [x, y, z], size: [w, d, h], count }: { readonly at: Point3; readonly size: Point3; readonly count: number }) =>
  Array.from({ length: count }, (_, i) => {
    const gz = z + (h * (i + 1)) / (count + 1)
    return <path key={gz} className="sb-arch-groove" d={path([[x + 6, y + d, gz], [x + w - 6, y + d, gz]], false)} />
  })

/** One solid recipe per shape. Every recipe stays inside PART_SIZE so the layout's bounds hold. */
const recipe = ({ component, origin: o, size: s }: PlacedPart): ReactNode => {
  const [x, y, z] = o
  const [w, d, h] = s
  const centre: readonly [number, number] = [x + w / 2, y + d / 2]
  switch (component.shape) {
    case "service":
      return <><Box at={o} size={s} /><Grooves at={o} size={s} count={3} /></>
    case "worker":
      return <><Box at={o} size={[w, d, h - 8]} /><Drum at={centre} r={14} z0={z + h - 8} z1={z + h} /></>
    case "cache":
      return <><Box at={o} size={s} /><Grooves at={o} size={s} count={2} /></>
    case "store":
      return [0, 1, 2].map((i) => <Drum key={i} at={centre} r={w / 2} z0={z + (h / 3) * i} z1={z + (h / 3) * (i + 1) - 2} />)
    case "queue":
      return (
        <>
          <Box at={o} size={[w, d, 6]} />
          {[0, 1, 2].map((i) => <Box key={i} at={[x + 6 + i * 21, y + 8, z + 6]} size={[14, d - 16, h - 6]} />)}
        </>
      )
    case "gateway":
      return (
        <>
          <Box at={o} size={[10, d, h - 8]} />
          <Box at={[x + w - 10, y, z]} size={[10, d, h - 8]} />
          <Box at={[x, y, z + h - 8]} size={[w, d, 8]} />
        </>
      )
    case "client":
      return <><Box at={o} size={[w, d, 6]} /><Box at={[x + 4, y + d / 2 - 3, z + 6]} size={[w - 8, 6, h - 6]} /></>
    case "external":
      return <><Drum at={centre} r={w / 2} z0={z} z1={z + h} /><Drum at={centre} r={w / 4} z0={z + h} z1={z + h + 1} /></>
  }
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export interface ArchitectureFigureProps {
  readonly block: PlanArchitectureBlock
}

/** A system drawn as an isometric bench of parts on layer plinths; the lit part is the subject. */
export function ArchitectureFigure({ block }: ArchitectureFigureProps) {
  const layout = layoutArchitecture(block)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  // Hover wins over keyboard focus; ids dropped by a newer block revision are ignored.
  const known = (id: string | null | undefined) => block.components.find((c) => c.id === id)
  const subject = known(hovered) ?? known(focused) ?? known(block.lit) ?? block.components[0]
  const focus = subject?.id
  const touches = (link: PlanArchitectureBlock["links"][number]) => link.from === focus || link.to === focus
  const outgoing = block.links.filter(({ from }) => from === focus)
  const incoming = block.links.filter(({ to }) => to === focus)

  return (
    <figure className="sb-arch" data-architecture={block.id}>
      <header className="sb-arch-head">
        <span className="sb-arch-title">{block.title ?? "System"}</span>
        <span className="sb-arch-hint">Hover or tab through the parts</span>
      </header>
      <svg viewBox={layout.viewBox} role="group" aria-label={`${block.title ?? "System"}: ${block.components.map(({ label }) => label).join(", ")}`}>
        {layout.layers.map(({ layer, origin, size }) => (
          <g key={layer.id} data-architecture-layer={layer.id}>
            <Box at={origin} size={size} />
            <text className="sb-arch-label" transform={frontFaceText([origin[0] + 10, origin[1] + size[1], origin[2] + size[2] - 4])}>
              {short(layer.label, 28)}
            </text>
          </g>
        ))}
        {layout.parts.map((part) => {
          const { component, pedestal } = part
          return (
            <g
              key={component.id}
              tabIndex={0}
              aria-label={`${component.label}, ${component.shape}${component.detail ? `, ${component.detail}` : ""}`}
              data-architecture-part={component.id}
              data-lit={component.id === block.lit ? "true" : undefined}
              className={cn("sb-arch-part", component.id === block.lit && "is-lit", component.id === focus && "is-focus")}
              role="group"
              onPointerEnter={() => setHovered(component.id)}
              onPointerLeave={() => setHovered((id) => (id === component.id ? null : id))}
              onFocus={() => setFocused(component.id)}
              onBlur={() => setFocused((id) => (id === component.id ? null : id))}
            >
              <Box at={pedestal} size={[PEDESTAL.width, PEDESTAL.depth, PEDESTAL.height]} />
              <text className="sb-arch-label sb-arch-label--part" transform={frontFaceText([pedestal[0] + 5, pedestal[1] + PEDESTAL.depth, 3])}>
                {short(component.label, 13)}
              </text>
              {recipe(part)}
            </g>
          )
        })}
        {layout.wires.map(({ link, index, points }) => (
          <g key={`${index}:${link.from}:${link.to}`} className={cn("sb-arch-wire", `is-${link.mode ?? "sync"}`, touches(link) && "is-hot")}>
            <path d={path(points, false)} />
            <path className="sb-arch-pulse" d={path(points, false)} />
            {[points[0]!, points.at(-1)!].map((p, end) => {
              const [cx, cy] = iso(p)
              return <circle key={end} className="sb-arch-terminal" cx={cx} cy={cy} r={2.5} />
            })}
          </g>
        ))}
      </svg>
      <figcaption className="sb-arch-readout" aria-live="polite" data-architecture-readout="true">
        {subject && (
          <>
            <strong>{subject.label}</strong> <span className="sb-arch-dim">{subject.shape}</span>
            {subject.detail && <> · {subject.detail}</>}
            {outgoing.length > 0 && <> · → {outgoing.map((l) => `${l.to}${l.label ? ` (${l.label})` : ""}`).join(", ")}</>}
            {incoming.length > 0 && <> · ← {incoming.map(({ from }) => from).join(", ")}</>}
          </>
        )}
      </figcaption>
    </figure>
  )
}
