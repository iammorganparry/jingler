import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Textarea } from "./textarea.js"

afterEach(cleanup)

describe("Textarea", () => {
  it("forwards value changes and the disabled state to the native element", () => {
    const onChange = vi.fn()
    const { rerender } = render(<Textarea aria-label="Body" value="" onChange={(e) => onChange(e.target.value)} />)
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "hello" } })
    expect(onChange).toHaveBeenCalledWith("hello")
    rerender(<Textarea aria-label="Body" value="" disabled onChange={() => {}} />)
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).disabled).toBe(true)
  })
})
