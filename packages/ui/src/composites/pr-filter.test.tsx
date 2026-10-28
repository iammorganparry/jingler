import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrFilter } from "./pr-filter.js"

afterEach(cleanup)

const layers = [{ number: 480 }, { number: 481 }, { number: 482 }]

describe("PrFilter", () => {
  it("shows the selected layer and reports the chosen PR number", () => {
    const onChange = vi.fn()
    render(<PrFilter layers={layers} value={481} onChange={onChange} />)
    const trigger = screen.getByRole("button", { name: "Filter by PR layer" })
    expect(trigger.textContent).toContain("PR: #481")
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: /PR: #482/ }))
    expect(onChange).toHaveBeenCalledWith(482)
  })
})
