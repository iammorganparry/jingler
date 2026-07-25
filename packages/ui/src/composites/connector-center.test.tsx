import type { ConnectorConnection, ConnectorProvider, OAuthClientInfo } from "@starbase/core"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// jsdom has no layout, so the real virtualizer measures a 0-height container and
// renders no rows. Mock it to render every item — this test covers the component's
// rendering + interaction logic, not tanstack's windowing.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 52, size: 52 }))
  })
}))

import { ConnectorCenter } from "./connector-center.js"

/**
 * The Connector Center browses providers and connects them. What matters: the
 * catalog filters, the connect drawer submits the entered values (secret flows OUT
 * through the callback), and disconnect fires — none of which should leak a value
 * anywhere but the outbound callback argument.
 */

afterEach(cleanup)

const providers: ReadonlyArray<ConnectorProvider> = [
  {
    id: "github",
    name: "GitHub",
    icon: null,
    authTypes: ["api_key"],
    fields: [{ name: "apiKey", label: "Personal access token", kind: "password", required: true }],
    actionCount: 42
  },
  { id: "slack", name: "Slack", icon: null, authTypes: ["oauth2"], fields: [], actionCount: 18 }
]

const connections: ReadonlyArray<ConnectorConnection> = [
  { service: "slack", accountId: "T1", displayName: "acme", grantedScopes: [], connectionName: null }
]

const oauthConfigs: ReadonlyArray<OAuthClientInfo> = []

const base = () => ({
  providers,
  connections,
  oauthConfigs,
  loading: false,
  error: null,
  onConnect: vi.fn(async () => {}),
  onDisconnect: vi.fn(async () => {}),
  onSetOauthConfig: vi.fn(async () => {}),
  onStartOauth: vi.fn(async () => {}),
  onRefresh: vi.fn()
})

describe("ConnectorCenter", () => {
  it("filters the catalog by the search query", () => {
    render(<ConnectorCenter {...base()} />)
    expect(screen.getByText("GitHub")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Search providers"), { target: { value: "git" } })
    expect(screen.getByText("GitHub")).toBeTruthy()
    expect(screen.queryByText("Slack")).toBeNull()
  })

  it("submits an api-key connection through onConnect (secret flows out only)", async () => {
    const props = base()
    render(<ConnectorCenter {...props} />)
    fireEvent.click(screen.getByText("GitHub"))
    const dialog = await screen.findByRole("dialog")
    const input = within(dialog).getByPlaceholderText("Personal access token")
    fireEvent.change(input, { target: { value: "ghp_secret" } })
    fireEvent.click(within(dialog).getByText("Connect"))
    await waitFor(() =>
      expect(props.onConnect).toHaveBeenCalledWith("github", "api_key", { apiKey: "ghp_secret" })
    )
  })

  it("disconnects an existing connection", async () => {
    const props = base()
    render(<ConnectorCenter {...props} />)
    fireEvent.click(screen.getByText("Disconnect"))
    await waitFor(() => expect(props.onDisconnect).toHaveBeenCalledWith("slack"))
  })

  it("shows the not-configured callout when unconfigured", () => {
    render(<ConnectorCenter {...base()} providers={[]} error="OpenConnector is not configured." />)
    expect(screen.getByText("OpenConnector is not configured.")).toBeTruthy()
  })
})
