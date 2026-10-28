import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PluginPaneState } from "./plugin-pane-state.js"

afterEach(cleanup)

describe("PluginPaneState", () => {
  it("shows skeleton rows while loading", () => {
    render(<PluginPaneState variant="loading" pluginId="p" />)
    expect(screen.getByTestId("plugin-pane-loading-p")).toBeTruthy()
    expect(screen.getAllByRole("status")).toHaveLength(4)
  })

  it("names the plugin when the pane is empty", () => {
    render(<PluginPaneState variant="empty" pluginId="p" />)
    expect(screen.getByText("Nothing to show yet")).toBeTruthy()
  })

  it("shows the crash message and Retry calls onRetry", async () => {
    const onRetry = vi.fn()
    render(<PluginPaneState variant="error" pluginId="p" message="boom" onRetry={onRetry} />)
    expect(screen.getByText("boom")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
