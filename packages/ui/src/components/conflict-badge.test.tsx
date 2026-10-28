// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConflictBadge } from "./conflict-badge.js"

afterEach(() => {
  cleanup()
})

describe("ConflictBadge", () => {
  it("shows the conflict label and the three resolutions", () => {
    render(<ConflictBadge value="keep-mine" />)
    expect(screen.getByText("Conflict")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Keep mine" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Replace" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Keep both" })).toBeTruthy()
  })

  it("calls onChange when a resolution is picked", () => {
    const onChange = vi.fn()
    render(<ConflictBadge value="keep-mine" onChange={onChange} />)
    fireEvent.click(screen.getByRole("tab", { name: "Replace" }))
    expect(onChange).toHaveBeenCalledWith("replace")
  })

  it("renders read-only without onChange (no apply-import support yet)", () => {
    render(<ConflictBadge value="keep-both" />)
    const tab = screen.getByRole("tab", { name: "Keep mine" })
    fireEvent.click(tab)
    // No onChange supplied: clicking must not throw and selection stays put.
    expect(screen.getByRole("tab", { name: "Keep both" }).getAttribute("aria-selected")).toBe("true")
  })
})
