import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SegmentedControl } from "./segmented-control.js"

afterEach(cleanup)

const items = [
  { value: "sessions", label: "Sessions" },
  { value: "explorer", label: "Explorer" }
] as const

describe("SegmentedControl (spec §3e)", () => {
  it("is a labelled 28px tablist with the active segment on the surface token", () => {
    render(<SegmentedControl aria-label="Workspace" items={items} value="sessions" />)
    expect(screen.getByRole("tablist", { name: "Workspace" })).toBeTruthy()
    const active = screen.getByRole("tab", { name: "Sessions" })
    expect(active.getAttribute("aria-selected")).toBe("true")
    expect(active.className).toContain("h-7")
    expect(active.className).not.toMatch(/text-primary-foreground/)
  })

  it("moves selection with arrow keys and on click", () => {
    const onChange = vi.fn()
    render(<SegmentedControl items={items} value="sessions" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole("tab", { name: "Sessions" }), { key: "ArrowRight" })
    expect(onChange).toHaveBeenLastCalledWith("explorer")
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }))
    expect(onChange).toHaveBeenLastCalledWith("sessions")
  })

  it("uses 24px segments at size sm", () => {
    render(<SegmentedControl size="sm" items={items} value="sessions" />)
    expect(screen.getByRole("tab", { name: "Explorer" }).className).toContain("h-6")
  })
})
