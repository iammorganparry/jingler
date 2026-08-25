import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BEUI_MOTION_COMPONENTS, BouncyAccordion, MotionTabs } from "./index.js"

describe("BeUI motion catalog", () => {
  it("keeps all 39 official Motion entries unique", () => {
    expect(BEUI_MOTION_COMPONENTS).toHaveLength(39)
    expect(new Set(BEUI_MOTION_COMPONENTS)).toHaveLength(39)
  })

  it("keeps tab selection keyboard-readable and controlled", () => {
    const onChange = vi.fn()
    render(<MotionTabs value="one" onChange={onChange} items={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />)
    expect(screen.getByRole("tab", { name: "One" }).getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: "Two" }))
    expect(onChange).toHaveBeenCalledWith("two")
  })

  it("exposes accordion disclosure state", () => {
    render(<BouncyAccordion items={[{ id: "tool", title: "Tool output", content: "Done" }]} />)
    const trigger = screen.getByRole("button", { name: "Tool output" })
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Done")).toBeTruthy()
  })
})
