import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Checkbox } from "./checkbox.js"

afterEach(cleanup)

describe("Checkbox (polish: 14px, r4, token border)", () => {
  it("is a 14px r4 box that toggles via onCheckedChange", () => {
    const onChange = vi.fn()
    render(<Checkbox label="Choice" id="c" onCheckedChange={onChange} />)
    const box = screen.getByRole("checkbox", { name: "Choice" })
    expect(box.className).toContain("size-[14px]")
    expect(box.className).toContain("rounded-[4px]")
    expect(box.className).toContain("border-line-strong")
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("reports checked and indeterminate state", () => {
    const { rerender } = render(<Checkbox aria-label="x" checked />)
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true")
    rerender(<Checkbox aria-label="x" indeterminate />)
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("mixed")
  })

  it("ignores clicks when disabled", () => {
    const onChange = vi.fn()
    render(<Checkbox aria-label="x" disabled onCheckedChange={onChange} />)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).not.toHaveBeenCalled()
  })
})
