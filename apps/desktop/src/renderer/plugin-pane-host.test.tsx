// @vitest-environment jsdom
import { lazy } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PluginPaneHost } from "./plugin-pane-host.js"

// Same reason as plugin-tab-host.test.tsx: the real bridge reaches a missing preload.
vi.mock("./rpc-client.js", () => ({
  rpc: {
    pluginsInvoke: vi.fn(async () => undefined),
    pluginsStorageGet: vi.fn(async () => undefined),
    pluginsStorageSet: vi.fn(async () => undefined),
    pluginsStorageDelete: vi.fn(async () => undefined),
    pluginsStorageKeys: vi.fn(async () => [])
  }
}))

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  cleanup()
})

const host = (child: React.ReactNode) => (
  <PluginPaneHost pluginId="p" reloadKey="p@1" session={null}>
    {child}
  </PluginPaneHost>
)

describe("PluginPaneHost states", () => {
  it("shows the crash state with Retry, and Retry re-mounts the pane", () => {
    let crash = true
    const Flaky = () => {
      if (crash) throw new Error("pane exploded")
      return <span>recovered</span>
    }
    render(host(<Flaky />))
    expect(screen.getByTestId("plugin-pane-error-p")).toBeTruthy()
    expect(screen.getByText("pane exploded")).toBeTruthy()
    crash = false
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByText("recovered")).toBeTruthy()
    expect(screen.queryByTestId("plugin-pane-error-p")).toBeNull()
  })

  it("shows the empty state when the pane renders nothing", () => {
    render(host(null))
    expect(screen.getByTestId("plugin-pane-empty-p")).toBeTruthy()
  })

  it("shows no empty state when the pane has content", () => {
    render(host(<span>content</span>))
    expect(screen.queryByTestId("plugin-pane-empty-p")).toBeNull()
  })

  it("shows the loading skeleton while the pane suspends", async () => {
    const Lazy = lazy(
      () => new Promise<{ default: () => React.ReactNode }>((r) => setTimeout(() => r({ default: () => <span>loaded</span> }), 20))
    )
    render(host(<Lazy />))
    expect(screen.getByTestId("plugin-pane-loading-p")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("loaded")).toBeTruthy())
    expect(screen.queryByTestId("plugin-pane-loading-p")).toBeNull()
  })
})
