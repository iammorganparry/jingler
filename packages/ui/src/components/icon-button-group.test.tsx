import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { IconButtonGroup } from "./icon-button-group.js"

afterEach(cleanup)

const icon = <svg aria-hidden />

describe("IconButtonGroup (spec §6.9)", () => {
  it("renders a named group with an accessible name per button", () => {
    render(
      <IconButtonGroup
        label="Browser navigation"
        items={[
          { id: "back", label: "Back", icon },
          { id: "reload", label: "Reload", icon }
        ]}
      />
    )
    const group = screen.getByRole("group", { name: "Browser navigation" })
    expect(group.querySelectorAll("button")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy()
  })

  it("fires onClick and skips disabled buttons", () => {
    const back = vi.fn()
    const reload = vi.fn()
    render(
      <IconButtonGroup
        label="Nav"
        items={[
          { id: "back", label: "Back", icon, disabled: true, onClick: back },
          { id: "reload", label: "Reload", icon, onClick: reload }
        ]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    expect(back).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
  })

  it("exposes aria-pressed only on toggle items", () => {
    render(
      <IconButtonGroup
        label="Widths"
        items={[
          { id: "a", label: "Phone", icon, pressed: true },
          { id: "b", label: "Tablet", icon, pressed: false },
          { id: "c", label: "Plain", icon }
        ]}
      />
    )
    expect(screen.getByRole("button", { name: "Phone" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "Tablet" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "Plain" }).hasAttribute("aria-pressed")).toBe(false)
  })

  it("moves focus with arrow keys, wrapping and skipping disabled buttons", () => {
    render(
      <IconButtonGroup
        label="Nav"
        items={[
          { id: "a", label: "A", icon },
          { id: "b", label: "B", icon, disabled: true },
          { id: "c", label: "C", icon }
        ]}
      />
    )
    const a = screen.getByRole("button", { name: "A" })
    const c = screen.getByRole("button", { name: "C" })
    a.focus()
    fireEvent.keyDown(a, { key: "ArrowRight" })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(c, { key: "ArrowRight" })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(a, { key: "ArrowLeft" })
    expect(document.activeElement).toBe(c)
  })
})
