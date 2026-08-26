import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Button } from "../button.js"
import { Checkbox } from "../checkbox.js"
import { Input } from "../input.js"
import { BEUI_MOTION_COMPONENTS, MotionTabs } from "./index.js"

describe("BeUI motion catalog", () => {
  it("keeps only production-used Motion entries unique", () => {
    expect(BEUI_MOTION_COMPONENTS).toHaveLength(15)
    expect(new Set(BEUI_MOTION_COMPONENTS)).toHaveLength(15)
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
      <Button onClick={onClick}>Continue</Button>
      <Checkbox checked={false} onCheckedChange={onCheckedChange} aria-label="Choice" />
      <Input aria-label="Name" />
    </>)

    const button = screen.getByRole("button", { name: "Continue" })
    expect(button.className).toContain("h-10")
    expect(button.className).toContain("rounded-lg")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()

    const checkbox = screen.getByRole("checkbox", { name: "Choice" })
    expect(checkbox.className).toContain("size-5")
    expect(checkbox.className).toContain("border-2")
    fireEvent.click(checkbox)
    expect(onCheckedChange).toHaveBeenCalledWith(true)

    const input = screen.getByRole("textbox", { name: "Name" })
    expect(input.className).toContain("h-11")
    expect(input.className).toContain("rounded-full")
  })
})
