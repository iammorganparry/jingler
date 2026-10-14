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

  it("omits the partial marker by default", () => {
    render(<KpiTile label="Runs" value="12" />)
    expect(screen.getByTestId("kpi-label").textContent).toBe("Runs")
  })

  it("renders a labelled placeholder for a missing value and the delta when given", () => {
    render(<KpiTile label="Success" value={null} delta="vs prior 7d" />)
    expect(screen.getByText("No data")).toBeTruthy()
    expect(screen.getByText("vs prior 7d")).toBeTruthy()
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

  it("renders an empty track for an empty array", () => {
    render(<StackedMiniBar label="None" values={[]} />)
    expect(screen.getByRole("img", { name: "None" }).querySelectorAll("rect")).toHaveLength(0)
  })

  it("ignores negative values and keeps zero segments zero-width", () => {
    render(<StackedMiniBar label="Mixed" values={[-5, 0, 2]} width={100} />)
    const rects = screen.getByRole("img", { name: "Mixed" }).querySelectorAll("rect")
    expect([...rects].map((rect) => rect.getAttribute("width"))).toEqual(["0", "0", "100"])
  })

  it("fills segments from the --sb-* token, never a hex", () => {
    render(<StackedMiniBar label="Tok" values={[1, 1]} />)
    const fills = [...screen.getByRole("img", { name: "Tok" }).querySelectorAll("rect")].map((rect) => rect.getAttribute("fill"))
    expect(fills.every((fill) => fill?.startsWith("var(--sb-"))).toBe(true)
  })
})
