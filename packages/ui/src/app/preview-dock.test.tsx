import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PreviewDock, type PreviewDockProps } from "./preview-dock.js"

afterEach(cleanup)

const props = (over: Partial<PreviewDockProps> = {}): PreviewDockProps => ({
  embedded: true,
  dock: "right",
  onDockChange: vi.fn(),
  visible: true,
  onToggle: vi.fn(),
  url: "http://localhost:3000",
  onNavigate: vi.fn(),
  onReload: vi.fn(),
  canGoBack: false,
  canGoForward: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
  onOpenExternal: vi.fn(),
  renderBrowser: () => null,
  ...over
})

describe("PreviewDock toolbar", () => {
  it("disables Back and Forward when there is no history", () => {
    render(<PreviewDock {...props()} />)
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled()
  })

  it("enables history buttons and routes every toolbar action", () => {
    const p = props({ canGoBack: true, canGoForward: true })
    render(<PreviewDock {...p} />)
    for (const name of ["Back", "Forward", "Reload", "Open in external browser"]) {
      fireEvent.click(screen.getByRole("button", { name }))
    }
    expect(p.onBack).toHaveBeenCalledOnce()
    expect(p.onForward).toHaveBeenCalledOnce()
    expect(p.onReload).toHaveBeenCalledOnce()
    expect(p.onOpenExternal).toHaveBeenCalledOnce()
  })

  it("marks the chosen device width pressed", () => {
    render(<PreviewDock {...props()} />)
    expect(screen.getByRole("button", { name: "Desktop" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Phone" }))
    expect(screen.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Desktop" })).toHaveAttribute("aria-pressed", "false")
  })

  it("shows a Retry that reloads on a load error and flags loading", () => {
    const p = props({ error: "ERR_CONNECTION_REFUSED", loading: true })
    render(<PreviewDock {...p} />)
    expect(screen.getByRole("alert")).toHaveTextContent("ERR_CONNECTION_REFUSED")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(p.onReload).toHaveBeenCalledOnce()
    expect(document.querySelector("[aria-busy=true]")).not.toBeNull()
  })

  it("submits the typed URL on Enter", () => {
    const p = props()
    render(<PreviewDock {...p} />)
    const input = screen.getByLabelText("Preview URL")
    fireEvent.change(input, { target: { value: " http://localhost:4000 " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(p.onNavigate).toHaveBeenCalledWith("http://localhost:4000")
  })
})
