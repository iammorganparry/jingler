import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"

afterEach(cleanup)

describe("Select (polish: h32 r8 trigger)", () => {
  it("has an h-8 rounded-lg trigger and selects an option from the keyboard", () => {
    const onValueChange = vi.fn()
    render(
      <Select onValueChange={onValueChange} defaultOpen>
        <SelectTrigger aria-label="Model"><SelectValue placeholder="Pick" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole("button", { name: "Model" })
    expect(trigger.className).toContain("h-8")
    expect(trigger.className).toContain("rounded-lg")
    const alpha = screen.getByRole("option", { name: "Alpha" })
    expect(alpha.className).toContain("h-8")
    fireEvent.keyDown(alpha, { key: "ArrowDown" })
    fireEvent.click(screen.getByRole("option", { name: "Beta" }))
    expect(onValueChange).toHaveBeenCalledWith("b")
  })
})
