import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TerminalPanel, terminalTabLabel, type TerminalPanelProps, type TerminalTab } from "./terminal-panel.js"

const LAST_EXIT = /last exit/
const running: TerminalTab = { id: "t1", title: "zsh", status: "running" }
const exited: TerminalTab = { id: "t2", title: "node", status: "exited", exitCode: 1 }

const panel = (props: Partial<TerminalPanelProps> = {}) => (
  <TerminalPanel
    tab={running}
    onRestart={vi.fn()}
    renderTerminal={(id) => <div data-testid={`cell-${id}`} />}
    {...props}
  />
)

afterEach(cleanup)

describe("TerminalPanel", () => {
  it("fills its tab with the live cell, no inner tab strip", () => {
    render(panel({ cwdLabel: "~/repo" }))
    expect(screen.getByTestId("terminal-panel").className).toContain("flex-1")
    expect(screen.getByTestId("cell-t1")).toBeTruthy()
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull()
    expect(screen.getByText("~/repo")).toBeTruthy()
  })

  it("offers Restart and the last exit only for an exited shell", () => {
    const onRestart = vi.fn()
    const { rerender } = render(panel({ onRestart }))
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull()
    expect(screen.queryByText(LAST_EXIT)).toBeNull()
    rerender(panel({ tab: exited, onRestart }))
    expect(screen.getByText("Shell exited with code 1")).toBeTruthy()
    expect(screen.getByText(LAST_EXIT)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    expect(onRestart).toHaveBeenCalledWith("t2")
  })
})

describe("terminalTabLabel", () => {
  it("numbers duplicate shell names", () => {
    const tabs: TerminalTab[] = [running, { ...running, id: "t3" }, exited]
    expect(tabs.map((tab) => terminalTabLabel(tabs, tab.id))).toEqual(["zsh", "zsh 2", "node"])
  })
})
