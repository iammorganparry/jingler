import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrStackRail, type PrStackLayer } from "./pr-stack-rail.js"

afterEach(cleanup)

const LAYERS: ReadonlyArray<PrStackLayer> = [
  { number: 480, title: "Schema", state: "merged", checks: "pass" },
  { number: 481, title: "API", state: "open", checks: "pass" },
  { number: 482, title: "UI", state: "open", checks: "fail" }
]

describe("PrStackRail", () => {
  it("lists layers base-up, in the order given", () => {
    render(<PrStackRail layers={LAYERS} selected={482} onSelect={() => {}} />)
    const order = screen.getAllByRole("button").map((b) => b.getAttribute("data-testid"))
    expect(order).toEqual(["pr-stack-layer-480", "pr-stack-layer-481", "pr-stack-layer-482"])
  })

  it("marks only the selected layer as current", () => {
    render(<PrStackRail layers={LAYERS} selected={481} onSelect={() => {}} />)
    expect(screen.getByTestId("pr-stack-layer-481").getAttribute("aria-current")).toBe("true")
    expect(screen.getByTestId("pr-stack-layer-480").getAttribute("aria-current")).toBeNull()
  })

  it("selects a layer on click", () => {
    const onSelect = vi.fn()
    render(<PrStackRail layers={LAYERS} selected={482} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("pr-stack-layer-480"))
    expect(onSelect).toHaveBeenCalledWith(480)
  })
})
