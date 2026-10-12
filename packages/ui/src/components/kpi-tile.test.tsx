import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { KpiTile, StackedMiniBar } from "./kpi-tile.js"

afterEach(cleanup)

describe("KpiTile", () => {
  it("shows the partial marker on the label line", () => {
    render(<KpiTile label="Cost" value="$4.20" partial />)
    const line = screen.getByTestId("kpi-label")
    expect(line.textContent).toBe("Costpartial")
    expect(line.className).toContain("whitespace-nowrap")
  })
})

describe("StackedMiniBar", () => {
  it("sizes segments proportionally from a plain array", () => {
    render(<StackedMiniBar label="Tokens by model" values={[3, 1]} width={100} />)
    const rects = screen.getByRole("img", { name: "Tokens by model" }).querySelectorAll("rect")
    expect([...rects].map((rect) => rect.getAttribute("width"))).toEqual(["75", "25"])
    expect(rects[1]?.getAttribute("x")).toBe("75")
  })

  it("renders an empty track for all-zero input", () => {
    render(<StackedMiniBar label="Empty" values={[0, 0]} />)
    expect(screen.getByRole("img", { name: "Empty" }).querySelectorAll("rect")).toHaveLength(0)
  })
})
