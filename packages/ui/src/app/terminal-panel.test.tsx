import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalPanel, type TerminalPanelProps, type TerminalTab } from "./terminal-panel.js"

const running: TerminalTab = { id: "t1", title: "zsh", status: "running" }
const exited: TerminalTab = { id: "t2", title: "node", status: "exited", exitCode: 1 }

const panel = (props: Partial<TerminalPanelProps> = {}) => (
  <TerminalPanel
    sessionId="s1"
    tabs={[running]}
    activeId="t1"
    onSelect={vi.fn()}
    onNew={vi.fn()}
    onClose={vi.fn()}
    onRestart={vi.fn()}
    renderTerminal={(id) => <div data-testid={`cell-${id}`} />}
    {...props}
  />
)

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("TerminalPanel layout", () => {
  it("fills the view with no fixed height or resize handle", () => {
    render(panel())
    const el = screen.getByTestId("terminal-panel") as HTMLElement
    expect(el.style.height).toBe("")
    expect(el.className).toContain("flex-1")
    expect(screen.queryByRole("separator", { name: "Resize terminal" })).toBeNull()
  })

  it("is hidden but keeps its shells mounted when not visible", () => {
    render(panel({ visible: false }))
    expect((screen.getByTestId("terminal-panel") as HTMLElement).className).toContain("hidden")
    expect(screen.getByTestId("cell-t1")).toBeTruthy()
  })
})

describe("TerminalPanel tabs and states", () => {
  it("renders a tab per terminal and selects/closes through the callbacks", () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(panel({ tabs: [running, exited], onSelect, onClose }))
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("tab", { name: "zsh" }).getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: "node" }))
    expect(onSelect).toHaveBeenCalledWith("t2")
    fireEvent.click(screen.getByRole("button", { name: "Close node" }))
    expect(onClose).toHaveBeenCalledWith("t2")
  })

  it("shows the No terminals empty state with a New terminal action", () => {
    const onNew = vi.fn()
    render(panel({ tabs: [], activeId: null, onNew }))
    expect(screen.getByText("No terminals")).toBeTruthy()
    fireEvent.click(screen.getByTestId("terminal-empty").querySelector("button") as HTMLElement)
    expect(onNew).toHaveBeenCalled()
  })

  it("offers Restart only for an exited active shell", () => {
    const onRestart = vi.fn()
    const { rerender } = render(panel({ tabs: [running, exited], activeId: "t1", onRestart }))
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull()
    rerender(panel({ tabs: [running, exited], activeId: "t2", onRestart }))
    expect(screen.getByText("Shell exited with code 1")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    expect(onRestart).toHaveBeenCalledWith("t2")
  })
})
