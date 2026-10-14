import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalPanel, terminalPanelHeightKey, type TerminalPanelProps, type TerminalTab } from "./terminal-panel.js"

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

const heightOf = () => (screen.getByTestId("terminal-panel") as HTMLElement).style.height

const drag = (from: number, to: number) => {
  fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize terminal" }), { clientY: from })
  fireEvent.pointerMove(window, { clientY: to })
  fireEvent.pointerUp(window)
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("TerminalPanel height", () => {
  it("defaults to 240px", () => {
    render(panel())
    expect(heightOf()).toBe("240px")
  })

  it("grows when the handle is dragged up and persists per session", () => {
    const { unmount } = render(panel())
    drag(500, 450)
    expect(heightOf()).toBe("290px")
    expect(localStorage.getItem(terminalPanelHeightKey("s1"))).toBe("290")
    unmount()

    render(panel())
    expect(heightOf()).toBe("290px")
    cleanup()
    render(panel({ sessionId: "s2" }))
    expect(heightOf()).toBe("240px")
  })

  it("clamps to the min and max", () => {
    render(panel())
    drag(500, 5000)
    expect(heightOf()).toBe("120px")
    drag(500, -5000)
    expect(heightOf()).toBe("720px")
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
