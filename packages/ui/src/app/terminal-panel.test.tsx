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
