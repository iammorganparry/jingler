import type { PlanArchitectureBlock } from "@jingler/core"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { VisualBlocks } from "../visual-blocks.js"

const block: PlanArchitectureBlock = {
  kind: "architecture",
  id: "checkout",
  title: "Checkout request path",
  layers: [{ id: "app", label: "App" }, { id: "data", label: "Data" }],
  components: [
    { id: "api", label: "orders-api", layer: "app", shape: "service", detail: "Hono, 3 replicas" },
    { id: "db", label: "Postgres", layer: "data", shape: "store", detail: "primary + replica" }
  ],
  links: [{ from: "api", to: "db", label: "INSERT", mode: "data" }],
  lit: "api"
}

afterEach(cleanup)

const readout = () => document.querySelector("[data-architecture-readout]")?.textContent ?? ""

describe("ArchitectureFigure", () => {
  it("renders every part and marks the lit subject", () => {
    render(<VisualBlocks blocks={[block]} />)
    expect(document.querySelectorAll("[data-architecture-part]")).toHaveLength(2)
    expect(document.querySelector('[data-lit="true"]')?.getAttribute("data-architecture-part")).toBe("api")
    expect(readout()).toContain("orders-api")
    expect(readout()).toContain("db (INSERT)")
  })

  it("shows the focused part's detail and returns to the lit part on blur", () => {
    render(<VisualBlocks blocks={[block]} />)
    const db = document.querySelector<SVGGElement>('[data-architecture-part="db"]')!
    fireEvent.focus(db)
    expect(readout()).toContain("primary + replica")
    expect(readout()).toContain("← api")
    expect(db.classList.contains("is-focus")).toBe(true)
    fireEvent.blur(db)
    expect(readout()).toContain("Hono, 3 replicas")
  })

  it("keeps keyboard focus in the readout after the pointer leaves another part", () => {
    render(<VisualBlocks blocks={[block]} />)
    const part = (id: string) => document.querySelector<SVGGElement>(`[data-architecture-part="${id}"]`)!
    fireEvent.focus(part("db"))
    fireEvent.pointerEnter(part("api"))
    expect(readout()).toContain("Hono, 3 replicas")
    fireEvent.pointerLeave(part("api"))
    expect(readout()).toContain("primary + replica")
  })

  it("falls back to the lit part when a revision removes the focused part", () => {
    const { rerender } = render(<VisualBlocks blocks={[block]} />)
    fireEvent.focus(document.querySelector('[data-architecture-part="db"]')!)
    rerender(<VisualBlocks blocks={[{ ...block, components: [block.components[0]!], links: [] }]} />)
    expect(readout()).toContain("orders-api")
  })

  it("exposes each part as a labelled group, not one flat image", () => {
    render(<VisualBlocks blocks={[block]} />)
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.getByRole("group", { name: "Postgres, store, primary + replica" })).toBeTruthy()
  })

  it("lights only the wires touching the focused part", () => {
    render(<VisualBlocks blocks={[{ ...block, lit: undefined, components: [...block.components, { id: "q", label: "events", layer: "app", shape: "queue" }] }]} />)
    fireEvent.focus(document.querySelector('[data-architecture-part="q"]')!)
    expect(document.querySelectorAll(".sb-arch-wire.is-hot")).toHaveLength(0)
  })
})
