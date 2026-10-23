import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Field } from "./field.js"
import { Input } from "./input.js"
import { Toggle } from "./toggle.js"

afterEach(cleanup)

describe("Field", () => {
  it("associates the label with the control and describes it with help", () => {
    render(<Field label="Server URL" help="Streamable HTTP endpoint">{(c) => <Input {...c} />}</Field>)
    const input = screen.getByLabelText("Server URL")
    expect(input.getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.getByText("Streamable HTTP endpoint").id).toBe(input.getAttribute("aria-describedby"))
  })

  it("announces the error and marks the control invalid and required", () => {
    render(<Field label="Name" required error="Name is required">{(c) => <Input {...c} />}</Field>)
    expect(screen.getByRole("alert").textContent).toBe("Name is required")
    const input = screen.getByLabelText(/Name/)
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(input.getAttribute("aria-required")).toBe("true")
  })
})

describe("Toggle sizes", () => {
  it("is 28x16 by default and 24x14 for sm, toggling aria-checked", () => {
    const onChange = vi.fn()
    render(<><Toggle aria-label="a" onCheckedChange={onChange} /><Toggle aria-label="b" size="sm" /></>)
    const a = screen.getByRole("switch", { name: "a" })
    expect(a.className).toContain("w-7")
    expect(a.className).toContain("h-4")
    expect(screen.getByRole("switch", { name: "b" }).className).toContain("w-6")
    fireEvent.click(a)
    expect(a.getAttribute("aria-checked")).toBe("true")
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("associates its visible label", () => {
    render(<Toggle label="Notify" />)
    expect(screen.getByLabelText("Notify").getAttribute("role")).toBe("switch")
  })
})
