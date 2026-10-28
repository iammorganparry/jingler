import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TitleBar } from "./title-bar.js"

afterEach(cleanup)

describe("TitleBar window controls (3.11)", () => {
  it.each(["win32", "linux"])("draws controls on %s and fires their handlers", (platform) => {
    const onMinimize = vi.fn()
    const onToggleMaximize = vi.fn()
    const onClose = vi.fn()
    render(<TitleBar platform={platform} windowControls={{ onMinimize, onToggleMaximize, onClose }} />)
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }))
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect([onMinimize, onToggleMaximize, onClose].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])
  })

  it("labels the middle button Restore when maximized", () => {
    render(<TitleBar platform="win32" windowControls={{ maximized: true }} />)
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy()
  })

  it("only Close turns red on hover", () => {
    render(<TitleBar platform="linux" />)
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("hover:bg-state-failed")
    expect(screen.getByRole("button", { name: "Minimize" }).className).not.toContain("state-failed")
  })

  it.each(["darwin", undefined])("renders no controls and keeps the traffic-light inset on %s", (platform) => {
    const { container } = render(<TitleBar platform={platform} />)
    expect(screen.queryByTestId("window-controls")).toBeNull()
    expect(container.querySelector("[data-testid=traffic-light-inset]")?.className).toContain("w-16")
  })
})
