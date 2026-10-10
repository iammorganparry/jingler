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

  it.each(["segment", "pill", "underline"] as const)("reveals offscreen %s tabs and skips disabled choices with keyboard navigation", (variant) => {
    const onChange = vi.fn()
    const view = render(<MotionTabs variant={variant} value="all" onChange={onChange} items={[
      { value: "all", label: "All files" },
      { value: "disabled", label: "Disabled", disabled: true },
      { value: "local", label: "Uncommitted" },
      { value: "pr", label: "Pull request" },
    ]} />)
    const viewport = view.container.querySelector('[role="tablist"]')!.parentElement!
    const scrollBy = vi.fn()
    Object.defineProperty(viewport, "scrollBy", { value: scrollBy, configurable: true })
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 40))
    const last = screen.getByRole("tab", { name: "Pull request" })
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 0, 80, 40))
    const first = screen.getByRole("tab", { name: "All files" })
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Uncommitted" }))
    expect(onChange).toHaveBeenLastCalledWith("local")
    fireEvent.keyDown(document.activeElement!, { key: "End" })
    expect(document.activeElement).toBe(last)
    expect(onChange).toHaveBeenLastCalledWith("pr")
    expect(scrollBy).toHaveBeenCalledWith({ left: 180, behavior: "smooth" })
    fireEvent.keyDown(last, { key: "Home" })
    expect(document.activeElement).toBe(first)
    expect(onChange).toHaveBeenLastCalledWith("all")
    expect(first.tabIndex).toBe(0)
    expect(last.tabIndex).toBe(-1)
    view.unmount()
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
    expect(input.className).toContain("rounded-xl")
  })
})
