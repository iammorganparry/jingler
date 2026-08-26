import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BEUI_MOTION_COMPONENTS, BouncyAccordion, MotionButton, MotionCheckbox, MotionInput, MotionTabs } from "./index.js"

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

  it("keeps the official BeUI control geometry and behavior", () => {
    const onClick = vi.fn()
    const onCheckedChange = vi.fn()
    render(<>
      <MotionButton onClick={onClick}>Continue</MotionButton>
      <MotionCheckbox checked={false} onCheckedChange={onCheckedChange} aria-label="Choice" />
      <MotionInput aria-label="Name" />
    </>)

    const button = screen.getByRole("button", { name: "Continue" })
    expect(button.className).toContain("h-10")
    expect(button.className).toContain("rounded-full")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()

    const checkbox = screen.getByRole("checkbox", { name: "Choice" })
    expect(checkbox.className).toContain("size-5")
    expect(checkbox.className).toContain("border-2")
    fireEvent.click(checkbox)
    expect(onCheckedChange).toHaveBeenCalledWith(true)

    const input = screen.getByRole("textbox", { name: "Name" })
    expect(input.parentElement?.className).toContain("h-11")
    expect(input.parentElement?.className).toContain("rounded-full")
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
