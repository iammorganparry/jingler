import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TurnFilter } from "./turn-filter.js"

afterEach(cleanup)

const turns = [
  { id: "a1", label: "Turn 1", paths: ["src/a.ts", "src/b.ts"] },
  { id: "a3", label: "Turn 3", paths: ["docs/c.md"] }
]

describe("TurnFilter", () => {
  it("shows All turns by default and reports the chosen turn id", () => {
    const onChange = vi.fn()
    render(<TurnFilter turns={turns} value={null} onChange={onChange} />)
    const trigger = screen.getByRole("button", { name: "Filter by turn" })
    expect(trigger.textContent).toContain("All turns")
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: /Turn 3/ }))
    expect(onChange).toHaveBeenCalledWith("a3")
  })

  it("reports null when All turns is picked again", () => {
    const onChange = vi.fn()
    render(<TurnFilter turns={turns} value="a1" onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Filter by turn" }))
    fireEvent.click(screen.getByRole("option", { name: "All turns" }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
