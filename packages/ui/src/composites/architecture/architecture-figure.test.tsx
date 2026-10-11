import type { PlanArchitectureBlock } from "@jingler/core"
import { cleanup, fireEvent, render } from "@testing-library/react"
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

  it("lights only the wires touching the focused part", () => {
    render(<VisualBlocks blocks={[{ ...block, lit: undefined, components: [...block.components, { id: "q", label: "events", layer: "app", shape: "queue" }] }]} />)
    fireEvent.focus(document.querySelector('[data-architecture-part="q"]')!)
    expect(document.querySelectorAll(".sb-arch-wire.is-hot")).toHaveLength(0)
  })
})
