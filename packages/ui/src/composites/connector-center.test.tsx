import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail,
  OAuthClientInfo
} from "@starbase/core"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// jsdom has no layout, so the real virtualizer measures a 0-height container and
// renders no rows. Mock it to render every row — this test covers the component's
// rendering + interaction logic, not tanstack's windowing.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 76, size: 76 }))
  })
}))

import { ConnectorCenter, columnsForWidth } from "./connector-center.js"

/**
 * The Connector Center browses ~1,100 providers as a grid and opens one at a
 * time. What matters here: search, the status tabs and the category filter
 * compose; opening a card announces WHICH provider so the detail can be fetched
 * lazily; and the whole surface stays free of credentials.
 *
 * The detail sheet's own behaviour (auth modes, scopes, no_auth) is covered in
 * `connector-detail.test.tsx`.
 */

afterEach(cleanup)

const providers: ReadonlyArray<ConnectorProvider> = [
  {
    id: "github",
    name: "GitHub",
    icon: null,
    categories: ["Developer Tools"],
    homepageUrl: "https://github.com/",
    authTypes: ["api_key"],
    actionCount: 42
  },
  {
    id: "slack",
    name: "Slack",
    icon: null,
    categories: ["Communication"],
    homepageUrl: "https://slack.com/",
    authTypes: ["oauth2"],
    actionCount: 18
  },
  {
    id: "gitlab",
    name: "GitLab",
    icon: null,
    categories: ["Developer Tools"],
    homepageUrl: "https://gitlab.com",
    authTypes: ["api_key"],
    actionCount: 12
  }
]

const connections: ReadonlyArray<ConnectorConnection> = [
  {
    service: "slack",
    accountId: "T1",
    displayName: "acme",
    grantedScopes: [],
    connectionName: null,
    removable: true,
    status: "connected"
  }
]

const oauthConfigs: ReadonlyArray<OAuthClientInfo> = []

const githubDetail: ConnectorProviderDetail = {
  id: "github",
  name: "GitHub",
  categories: ["Developer Tools"],
  homepageUrl: "https://github.com/",
  authTypes: ["api_key"],
  keyModes: [
    {
      type: "api_key",
      label: null,
      description: null,
      fields: [
    {
      name: "apiKey",
      label: "Personal access token",
      kind: "password",
      required: true,
      placeholder: "ghp_..."
    }
  ]
    }
  ],
  oauthScopes: [],
  actionCount: 42
}

const base = () => ({
  providers,
  connections,
  oauthConfigs,
  loading: false,
  error: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  onOpenProvider: vi.fn(),
  onConnect: vi.fn(async () => {}),
  onDisconnect: vi.fn(async () => {}),
  onSetOauthConfig: vi.fn(async () => {}),
  onStartOauth: vi.fn(async () => {}),
  onRefresh: vi.fn()
})

/** The catalog region, scoped — "GitHub" is also a Settings nav entry. */
const catalog = () => within(screen.getByRole("group", { name: "Provider catalog" }))

describe("ConnectorCenter", () => {
  it("filters the catalog by the search query", () => {
    render(<ConnectorCenter {...base()} />)
    expect(catalog().getByRole("button", { name: "GitHub" })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Search providers"), { target: { value: "slack" } })
    expect(catalog().getByRole("button", { name: "Slack" })).toBeTruthy()
    expect(catalog().queryByRole("button", { name: "GitHub" })).toBeNull()
  })

  it("splits the catalog by connection status, and the tab counts say how", () => {
    render(<ConnectorCenter {...base()} />)
    // Counts are rendered into the tab labels so the operator can see the split
    // without switching to it.
    expect(screen.getByRole("tab", { name: /All 3/ })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /Connected 1/ })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /Not connected 2/ })).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: /Connected 1/ }))
    expect(catalog().getByRole("button", { name: "Slack" })).toBeTruthy()
    expect(catalog().queryByRole("button", { name: "GitHub" })).toBeNull()
  })

  it("composes the status filter with the search query", () => {
    render(<ConnectorCenter {...base()} />)
    fireEvent.change(screen.getByLabelText("Search providers"), { target: { value: "git" } })
    // The counts re-scope to the search, so "Connected" now describes 0 of 2 —
    // not 1 of 3, which would promise a result the tab cannot show.
    expect(screen.getByRole("tab", { name: /All 2/ })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /Connected 0/ })).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: /Not connected 2/ }))
    expect(catalog().getByRole("button", { name: "GitHub" })).toBeTruthy()
    expect(catalog().getByRole("button", { name: "GitLab" })).toBeTruthy()
  })

  it("announces which provider was opened so its detail can be fetched", async () => {
    const props = base()
    render(<ConnectorCenter {...props} />)
    fireEvent.click(catalog().getByRole("button", { name: "GitHub" }))
    await waitFor(() => expect(props.onOpenProvider).toHaveBeenCalledWith("github"))
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it("submits an api-key connection through onConnect (secret flows out only)", async () => {
    const props = base()
    const { rerender } = render(<ConnectorCenter {...props} />)
    fireEvent.click(catalog().getByRole("button", { name: "GitHub" }))
    // The detail arrives a tick later, the way the real query resolves.
    rerender(<ConnectorCenter {...props} detail={githubDetail} />)

    const dialog = await screen.findByRole("dialog")
    // The REAL placeholder from the provider's own descriptor — not the generic
    // "API key" fallback every provider used to get.
    const input = within(dialog).getByPlaceholderText("ghp_...")
    fireEvent.change(input, { target: { value: "ghp_secret" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(props.onConnect).toHaveBeenCalledWith(
        "github",
        "api_key",
        { apiKey: "ghp_secret" },
        // "default" is the default connection, addressed by omitting the alias.
        undefined
      )
    )
  })

  it("disconnects an existing connection from the provider's own sheet", async () => {
    const props = base()
    render(<ConnectorCenter {...props} />)
    fireEvent.click(catalog().getByRole("button", { name: "Slack" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByText("Disconnect"))
    await waitFor(() => expect(props.onDisconnect).toHaveBeenCalledWith("slack", null))
  })

  /**
   * A `pending` connection is listed but cannot run an action — an OAuth grant
   * begun and not yet consented. Counting it as connected would put a green dot
   * and a "Manage" affordance on a provider that does not work, and inflate the
   * Connected tab with it.
   */
  it("counts a pending connection as not connected, and says so on the card", () => {
    const props = base()
    render(
      <ConnectorCenter
        {...props}
        connections={[
          {
            service: "github",
            accountId: "",
            displayName: null,
            grantedScopes: [],
            connectionName: null,
            removable: true,
            status: "pending"
          },
          ...connections
        ]}
      />
    )
    // Slack is genuinely connected; GitHub's grant is only half-finished.
    expect(screen.getByRole("tab", { name: /Connected 1/ })).toBeTruthy()
    expect(screen.getByRole("tab", { name: /Not connected 2/ })).toBeTruthy()

    const card = catalog().getByRole("button", { name: "GitHub" })
    expect(within(card).getByText("Pending")).toBeTruthy()
    expect(within(card).queryByText("Manage")).toBeNull()

    // And it stays out of the Connected tab.
    fireEvent.click(screen.getByRole("tab", { name: /Connected 1/ }))
    expect(catalog().queryByRole("button", { name: "GitHub" })).toBeNull()
  })

  /**
   * The column count is measured off the CONTAINER, and these thresholds assume
   * that. Settings puts a fixed 216px nav rail beside this pane, so measuring the
   * window instead would fire each breakpoint ~240px early and pick a 3-up for a
   * container that fits 2.
   */
  it("picks a column count a container that wide can actually fit", () => {
    // n columns need n * 240 + (n - 1) * 8.
    expect(columnsForWidth(487)).toBe(1)
    expect(columnsForWidth(488)).toBe(2)
    expect(columnsForWidth(735)).toBe(2)
    expect(columnsForWidth(736)).toBe(3)

    // The width Settings actually hands this pane. It shipped rendering a single
    // column here because the two-column threshold sat ten pixels above it — a
    // grid that was never a grid in the one place it ships.
    expect(columnsForWidth(558)).toBe(2)

    // And the case the original window-measured version got wrong: a 1100px
    // window with the nav rail open leaves ~836px of pane.
    expect(columnsForWidth(1100 - 216 - 48)).toBe(3)
  })

  it("shows the not-configured callout when unconfigured", () => {
    render(<ConnectorCenter {...base()} providers={[]} error="OpenConnector is not configured." />)
    expect(screen.getByText("OpenConnector is not configured.")).toBeTruthy()
  })
})
