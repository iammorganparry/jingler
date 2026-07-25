import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ResizeHandle } from "./resizable.js"

afterEach(() => {
  cleanup()
  document.body.style.cursor = ""
  document.body.style.userSelect = ""
})

describe("ResizeHandle", () => {
  it("restores document drag state when unmounted mid-drag", () => {
    const view = render(<ResizeHandle onResize={() => {}} />)
    const handle = view.getByRole("separator")

    fireEvent.pointerDown(handle, { clientX: 10 })
    expect(document.body.style.cursor).toBe("col-resize")
    expect(document.body.style.userSelect).toBe("none")

    view.unmount()
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
  })
})
