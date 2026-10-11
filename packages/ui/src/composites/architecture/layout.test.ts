import type { PlanArchitectureBlock } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { depthOf, iso, layoutArchitecture } from "./layout.js"

const block: PlanArchitectureBlock = {
  kind: "architecture",
  id: "checkout",
  layers: [{ id: "edge", label: "Edge" }, { id: "app", label: "App" }, { id: "data", label: "Data" }],
  components: [
    { id: "gw", label: "API gateway", layer: "edge", shape: "gateway" },
    { id: "api", label: "orders-api", layer: "app", shape: "service" },
    { id: "q", label: "order-events", layer: "app", shape: "queue" },
    { id: "db", label: "Postgres", layer: "data", shape: "store" }
  ],
  links: [
    { from: "gw", to: "api", mode: "sync" },
    { from: "api", to: "q", mode: "async" },
    { from: "api", to: "db", mode: "data" }
  ],
  lit: "api"
}

describe("iso projection", () => {
  it("projects floor axes to unit length and height straight up", () => {
    const [x, y] = iso([1, 0, 0])
    expect(Math.hypot(x, y * 2)).toBeCloseTo(1)
    expect(iso([0, 0, 10])).toEqual([0, expect.closeTo(-8.66, 2)])
    expect(depthOf([0, 10, 0])).toBeGreaterThan(depthOf([0, 0, 0]))
    expect(depthOf([0, 0, 10])).toBeGreaterThan(depthOf([0, 0, 0]))
  })
})

describe("layoutArchitecture", () => {
  it("is deterministic", () => {
    expect(layoutArchitecture(block)).toEqual(layoutArchitecture(block))
  })

  it("puts each part on its own layer's plinth", () => {
    const { layers, parts } = layoutArchitecture(block)
    for (const part of parts) {
      const plinth = layers.find(({ layer }) => layer.id === part.component.layer)!
      expect(part.pedestal[1]).toBeGreaterThanOrEqual(plinth.origin[1])
      expect(part.pedestal[1]).toBeLessThanOrEqual(plinth.origin[1] + plinth.size[1])
      expect(part.pedestal[0]).toBeGreaterThanOrEqual(0)
      expect(part.pedestal[0]).toBeLessThanOrEqual(plinth.size[0])
    }
  })

  it("paints back to front", () => {
    const { parts } = layoutArchitecture(block)
    const depths = parts.map(({ depth }) => depth)
    expect(depths).toEqual([...depths].sort((a, b) => a - b))
    expect(parts.at(-1)?.component.id).toBe("db")
  })

  it("ends every wire on the ports of its two parts", () => {
    const { parts, wires } = layoutArchitecture(block)
    expect(wires).toHaveLength(3)
    const port = (id: string) => parts.find(({ component }) => component.id === id)!.port
    for (const { link, points } of wires) {
      expect(points[0]).toEqual(port(link.from))
      expect(points.at(-1)).toEqual(port(link.to))
      // The tray runs above every part, so a wire never cuts through one.
      for (const p of points.slice(1, -1)) expect(p[2]).toBeGreaterThan(Math.max(...parts.map((part) => part.port[2])))
    }
  })

  it("wraps a dense layer into bounded rows instead of one wide plinth", () => {
    const dense: PlanArchitectureBlock = {
      kind: "architecture",
      id: "dense",
      layers: [{ id: "app", label: "App" }, { id: "data", label: "Data" }],
      components: [
        ...Array.from({ length: 23 }, (_, i) => ({ id: `s${i}`, label: `svc-${i}`, layer: "app", shape: "service" as const })),
        { id: "db", label: "Postgres", layer: "data", shape: "store" }
      ],
      links: [],
      lit: undefined
    }
    const { layers, parts } = layoutArchitecture(dense)
    const [app, data] = layers
    expect(app!.size[0]).toBe(6 * 96 + 2 * 28)
    expect(app!.size[1]).toBe(4 * 104)
    expect(data!.origin[1]).toBeGreaterThan(app!.origin[1] + app!.size[1])
    const db = parts.find(({ component }) => component.id === "db")!
    expect(db.pedestal[1]).toBeGreaterThanOrEqual(data!.origin[1])
    const keys = new Set(parts.map(({ pedestal }) => pedestal.join()))
    expect(keys.size).toBe(parts.length)
  })

  it("fits everything in the viewBox", () => {
    const [, , w, h] = layoutArchitecture(block).viewBox.split(" ").map(Number)
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
  })
})
