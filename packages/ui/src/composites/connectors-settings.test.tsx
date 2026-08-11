import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectorsSettings } from "./connectors-settings.js"
import type { OpenConnectorSectionProps } from "./open-connector-section.js"
import type { ConnectorCenterProps } from "./connector-center.js"
import type { McpServerStatus } from "@jingler/core"

afterEach(cleanup)

/**
 * The gate is the point of this composite: the provider catalog is only reachable
 * once a LIVE probe says the configured OpenConnector instance answers. Anything
 * less and the operator lands on "Search 0 providers" with no way to tell a broken
 * instance from an empty one — the dead end this section replaced.
 */
const unified = (
  over: Partial<OpenConnectorSectionProps> = {}
): OpenConnectorSectionProps => ({
  config: { endpoint: "http://localhost:8080/mcp", enabled: true, serverName: "open-connector" },
  hasToken: true,
  defaults: undefined,
  loading: false,
  save: async () => {},
  autoSetup: async () => {},
  settingUp: false,
  status: null,
  testing: false,
  test: () => {},
  ...over
})

const connected: McpServerStatus = {
  name: "open-connector",
  scope: "user",
  state: "connected",
  toolCount: 12,
  error: null,
  checkedAt: "2026-01-01T00:00:00.000Z"
}

const connector = (over: Partial<ConnectorCenterProps> = {}): ConnectorCenterProps => ({
  providers: [
    {
      id: "linear",
      name: "Linear",
      icon: null,
      categories: ["Productivity"],
      homepageUrl: "https://linear.app",
      authTypes: ["oauth2"],
      actionCount: 6
    }
  ],
  connections: [],
  oauthConfigs: [],
  loading: false,
  error: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  onOpenProvider: () => {},
  onConnect: async () => {},
  onDisconnect: async () => {},
  onSetOauthConfig: async () => {},
  onStartOauth: async () => {},
  onRefresh: () => {},
  ...over
})

describe("ConnectorsSettings", () => {
  it("probes the instance once when the section opens", () => {
    const test = vi.fn()
    render(<ConnectorsSettings unifiedMcp={unified({ test })} connector={connector()} />)

    expect(test).toHaveBeenCalledTimes(1)
  })

  /**
   * Regression: `useOpenConnector` handed back a NEW `test` every render (a
   * `useCallback` keyed on React Query's mutation object). Keyed on `test` alone,
   * the probe effect re-fired on every render — an unbounded loop that pinned the
   * renderer and made Settings stop answering clicks entirely.
   */
  it("still probes only once when the caller hands back a new `test` each render", () => {
    const test = vi.fn()
    const { rerender } = render(
      <ConnectorsSettings unifiedMcp={unified({ test: () => test() })} connector={connector()} />
    )
    for (let i = 0; i < 5; i++) {
      rerender(
        <ConnectorsSettings unifiedMcp={unified({ test: () => test() })} connector={connector()} />
      )
    }

    expect(test).toHaveBeenCalledTimes(1)
  })

  it("shows the connection setup — not the catalog — until the probe connects", () => {
    render(<ConnectorsSettings unifiedMcp={unified()} connector={connector()} />)

    expect(screen.getByText(/Unified MCP/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Search/)).toBeNull()
  })

  it("shows the setup view when the probe fails, so the failure is fixable in place", () => {
    render(
      <ConnectorsSettings
        unifiedMcp={unified({
          status: { ...connected, state: "failed", toolCount: null, error: "Couldn't reach" }
        })}
        connector={connector()}
      />
    )

    expect(screen.getByText(/Unified MCP/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Search/)).toBeNull()
  })

  it("swaps to the catalog once connected", () => {
    render(
      <ConnectorsSettings
        unifiedMcp={unified({ status: connected })}
        connector={connector()}
      />
    )

    expect(screen.getByPlaceholderText(/Search/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Manage connection/ })).toBeTruthy()
  })

  it("reveals the setup again from the connected view without losing the way back", () => {
    render(
      <ConnectorsSettings
        unifiedMcp={unified({ status: connected })}
        connector={connector()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /Manage connection/ }))
    expect(screen.getByText(/Unified MCP/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /Back to connectors/ }))
    expect(screen.getByPlaceholderText(/Search/)).toBeTruthy()
  })
})
