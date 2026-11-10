import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpComposerMenu, McpConnectorsView, type McpCatalogEntry, type McpConnectorRow } from "./mcp-connectors.js"

afterEach(cleanup)

const row = (id: string, over: Partial<McpConnectorRow> = {}): McpConnectorRow => ({
  id, displayName: id, iconUrl: null, target: `${id}.example/mcp`, source: "jingler",
  agents: "All agents", state: "connected", toolCount: 10, enabled: true, ...over
})
const rows = [
  row("linear", { source: "claude.ai", state: "needs-auth", toolCount: null }),
  row("sentry", { state: "needs-auth", toolCount: null }),
  row("paper")
]
const catalog: ReadonlyArray<McpCatalogEntry> = [
  { id: "a", origin: "registry", displayName: "GitHub", iconUrl: null, description: "repos", registryName: "io.github", kind: "Remote" },
  { id: "b", origin: "codex", displayName: "context7", iconUrl: null, description: "docs", registryName: "~/.codex", kind: "Remote" },
  { id: "c", origin: "claude.ai", displayName: "Slack", iconUrl: null, description: "chat", registryName: "claude.ai Slack", kind: "Org", added: "needs-auth" }
]
const noop = () => {}
const view = (over: Partial<Parameters<typeof McpConnectorsView>[0]> = {}) =>
  render(<McpConnectorsView rows={rows} catalog={catalog} onReconnect={noop} onOpen={noop} onAddCustom={noop} onAddFromCatalog={noop} {...over} />)

describe("McpConnectorsView", () => {
  it("reconnects inline and filters to servers that need sign-in", () => {
    const onReconnect = vi.fn()
    view({ onReconnect })
    expect(screen.getByText(/2 servers need sign-in/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect linear" }))
    expect(onReconnect).toHaveBeenCalledWith(rows[0])
    fireEvent.click(screen.getByRole("button", { name: "Show only these" }))
    expect(screen.queryByText("paper")).toBeNull()
  })

  it("groups Discover by source with claude.ai and harnesses above the registry", () => {
    const onAddFromCatalog = vi.fn()
    view({ initialTab: "discover", onAddFromCatalog })
    const sections = screen.getAllByRole("region").map((section) => section.getAttribute("aria-label"))
    expect(sections).toEqual(["claude.ai servers", "Codex servers", "Registry servers"])
    fireEvent.click(screen.getByRole("button", { name: "Import context7" }))
    expect(onAddFromCatalog).toHaveBeenCalledWith(catalog[1])
    expect(within(screen.getByRole("region", { name: "claude.ai servers" })).getByRole("button", { name: "Connect" })).toBeTruthy()
  })
})

describe("McpComposerMenu", () => {
  it("toggles per chat and collapses extra sign-ins into +N more", () => {
    const onToggle = vi.fn()
    const onManage = vi.fn()
    render(<McpComposerMenu rows={rows} onToggle={onToggle} onReconnect={noop} onBrowse={noop} onManage={onManage} reconnectLimit={1} />)
    fireEvent.click(screen.getByRole("switch", { name: "Use paper in this chat" }))
    expect(onToggle).toHaveBeenCalledWith(rows[2], false)
    fireEvent.click(screen.getByRole("menuitem", { name: /\+1 more need sign-in/ }))
    expect(onManage).toHaveBeenCalledOnce()
  })
})
