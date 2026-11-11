import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpConnectorRow } from "./mcp-connectors.js"
import { McpAddServerDialog, McpServerDrawer } from "./mcp-server-drawer.js"

afterEach(cleanup)

const row: McpConnectorRow = {
  id: "sentry", displayName: "Sentry", iconUrl: null, target: "mcp.sentry.dev/mcp", source: "jingler",
  agents: "All agents", state: "needs-auth", toolCount: null, enabled: true
}
const noop = () => {}
const drawer = (over: Partial<Parameters<typeof McpServerDrawer>[0]> = {}) =>
  render(
    <McpServerDrawer
      row={row} onOpenChange={noop} toolNames={["search", "update"]} disabledTools={["update"]}
      onToggleTool={noop} onEnabledChange={noop} onReconnect={noop} onTest={noop} onRemove={noop}
      logLines={[]} {...over}
    />
  )

describe("McpServerDrawer", () => {
  it("reconnects a Jingler server and toggles tools from the Tools tab", () => {
    const onReconnect = vi.fn()
    const onToggleTool = vi.fn()
    drawer({ onReconnect, onToggleTool })
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    expect(onReconnect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("tab", { name: "Tools 1/2" }))
    fireEvent.click(screen.getByRole("switch", { name: "Enable tool update" }))
    expect(onToggleTool).toHaveBeenCalledWith("update", true)
  })

  it("shows a failed action inside the drawer", () => {
    drawer({ error: "fetch failed: self-signed certificate in certificate chain" })
    expect(screen.getByRole("alert").textContent).toContain("self-signed certificate")
  })

  it("offers to remove the unsigned Jingler copy behind a claude.ai connector", () => {
    const onRemoveCopy = vi.fn()
    drawer({ row: { ...row, source: "claude.ai", state: "connected", jinglerCopy: "gdocs" }, onRemoveCopy })
    fireEvent.click(screen.getByRole("button", { name: "Remove Jingler copy" }))
    expect(onRemoveCopy).toHaveBeenCalledWith("gdocs")
  })

  it("sends claude.ai connectors to claude.ai and blocks Remove", () => {
    drawer({ row: { ...row, source: "claude.ai" } })
    expect(screen.getByRole("button", { name: "Connect on claude.ai" })).toBeTruthy()
    expect((screen.getByRole("button", { name: "Remove server" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("McpAddServerDialog", () => {
  it("shows the trust note and offers the registry", () => {
    const onBrowse = vi.fn()
    render(<McpAddServerDialog open onOpenChange={noop} add={async () => {}} onBrowse={onBrowse} />)
    expect(screen.getByText(/Only add servers from developers you trust/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Browse the registry instead" }))
    expect(onBrowse).toHaveBeenCalledOnce()
  })
})
