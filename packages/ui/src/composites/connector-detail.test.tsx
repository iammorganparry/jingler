import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail
} from "@starbase/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ConnectorDetail } from "./connector-detail.js"

/**
 * The detail sheet is where a provider's REAL connect form lives. Before it, the
 * catalog carried no auth fields at all and every provider fell through to one
 * generic "API key" box — so these tests are mostly about the form matching what
 * the provider actually accepts: OAuth only, key only, both, or neither.
 */

afterEach(cleanup)

const card = (over: Partial<ConnectorProvider> = {}): ConnectorProvider => ({
  id: "linear",
  name: "Linear",
  icon: null,
  categories: ["Productivity"],
  homepageUrl: "https://linear.app",
  authTypes: ["oauth2", "api_key"],
  actionCount: 34,
  ...over
})

const detail = (over: Partial<ConnectorProviderDetail> = {}): ConnectorProviderDetail => ({
  id: "linear",
  name: "Linear",
  categories: ["Productivity"],
  homepageUrl: "https://linear.app",
  authTypes: ["oauth2", "api_key"],
  fields: [
    {
      name: "apiKey",
      label: "Personal API Key",
      kind: "password",
      required: true,
      placeholder: "lin_api_..."
    }
  ],
  oauthScopes: ["read", "write", "issues:create"],
  actionCount: 34,
  description: null,
  ...over
})

const base = () => ({
  provider: card(),
  detail: detail(),
  detailLoading: false,
  detailError: null,
  connections: [] as ReadonlyArray<ConnectorConnection>,
  oauthInfo: undefined,
  onClose: vi.fn(),
  onConnect: vi.fn(async () => {}),
  onDisconnect: vi.fn(async () => {}),
  onSetOauthConfig: vi.fn(async () => {}),
  onStartOauth: vi.fn(async () => {})
})

describe("ConnectorDetail", () => {
  it("defaults a dual-auth provider to OAuth and keeps the key form one click away", async () => {
    const props = base()
    render(<ConnectorDetail {...props} />)

    expect(screen.getByRole("button", { name: "Connect with OAuth" })).toBeTruthy()
    // The OAuth pane is showing, so the key field must not be — otherwise the
    // operator sees two competing ways to connect at once.
    expect(screen.queryByPlaceholderText("lin_api_...")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "API key" }))
    expect(screen.getByPlaceholderText("lin_api_...")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Connect with OAuth" })).toBeNull()
  })

  it("lists the OAuth scopes the provider's actions will request", () => {
    render(<ConnectorDetail {...base()} />)
    expect(screen.getByText("issues:create")).toBeTruthy()
    expect(screen.getByText("write")).toBeTruthy()
  })

  it("offers no key form for an oauth-only provider", () => {
    render(
      <ConnectorDetail
        {...base()}
        provider={card({ id: "slack", name: "Slack", authTypes: ["oauth2"] })}
        detail={detail({ id: "slack", name: "Slack", authTypes: ["oauth2"], fields: [] })}
      />
    )
    expect(screen.getByRole("button", { name: "Connect with OAuth" })).toBeTruthy()
    expect(screen.queryByRole("tab", { name: "API key" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
  })

  it("offers no OAuth button for a key-only provider", () => {
    render(
      <ConnectorDetail
        {...base()}
        provider={card({ id: "github", name: "GitHub", authTypes: ["api_key"] })}
        detail={detail({
          id: "github",
          name: "GitHub",
          authTypes: ["api_key"],
          oauthScopes: [],
          fields: [
            { name: "apiKey", label: "Personal access token", kind: "password", required: true }
          ]
        })}
      />
    )
    expect(screen.queryByRole("button", { name: "Connect with OAuth" })).toBeNull()
    expect(screen.getByPlaceholderText("Personal access token")).toBeTruthy()
  })

  it("shows a no_auth provider as ready, with nothing to fill in", () => {
    render(
      <ConnectorDetail
        {...base()}
        provider={card({ id: "hackernews", name: "Hacker News", authTypes: ["no_auth"] })}
        detail={detail({
          id: "hackernews",
          name: "Hacker News",
          authTypes: ["no_auth"],
          fields: [],
          oauthScopes: []
        })}
      />
    )
    expect(screen.getByText(/No auth needed/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect with OAuth" })).toBeNull()
  })

  it("sends a named alias only when it differs from the default connection", async () => {
    const props = base()
    render(<ConnectorDetail {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "API key" }))
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" }
    })

    // As shipped the field reads "default". OpenConnector resolves that to the
    // same connection as an omitted name, and omitted is the canonical form —
    // so the whole app spells the default connection exactly one way.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(props.onConnect).toHaveBeenCalledWith(
        "linear",
        "api_key",
        { apiKey: "lin_api_secret" },
        undefined
      )
    )
  })

  it("passes a real alias through when the operator names the connection", async () => {
    const props = base()
    render(<ConnectorDetail {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "API key" }))
    fireEvent.change(screen.getByPlaceholderText("default"), { target: { value: "work" } })
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" }
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(props.onConnect).toHaveBeenCalledWith(
        "linear",
        "api_key",
        { apiKey: "lin_api_secret" },
        "work"
      )
    )
  })

  it("collects OAuth client credentials before offering to connect", () => {
    render(
      <ConnectorDetail
        {...base()}
        oauthInfo={{
          provider: "linear",
          expectedRedirectUri: "http://localhost:3000/oauth/callback",
          hasClient: false,
          clientFields: []
        }}
      />
    )
    expect(screen.getByText("http://localhost:3000/oauth/callback")).toBeTruthy()
    expect(screen.getByPlaceholderText("Client ID")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Connect with OAuth" })).toBeNull()
  })

  it("disconnects a NAMED connection by its alias, not as the default one", async () => {
    const props = base()
    render(
      <ConnectorDetail
        {...props}
        connections={[
          {
            service: "linear",
            accountId: "acct_1",
            displayName: "Acme",
            grantedScopes: ["read", "write"],
            connectionName: "work",
            removable: true,
            status: "connected"
          }
        ]}
      />
    )
    expect(screen.getByText(/2 scopes/)).toBeTruthy()
    fireEvent.click(screen.getByText("Disconnect"))
    await waitFor(() => expect(props.onDisconnect).toHaveBeenCalledWith("linear", "work"))
  })

  /**
   * The one that matters most here. Swapping provider A for provider B WITHOUT
   * passing through null is a plain re-render — React reconciles the same element
   * type in the same position and keeps its state — so without a key on the form,
   * a typed api key survives into the other provider's form. The grid can't
   * currently perform that swap (its dialog is modal), but this component is
   * exported, so the guarantee has to hold on its own.
   */
  it("carries no typed secret across a direct provider swap", () => {
    const props = base()
    const { rerender } = render(<ConnectorDetail {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "API key" }))
    fireEvent.change(screen.getByPlaceholderText("default"), { target: { value: "work" } })
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), {
      target: { value: "lin_api_secret" }
    })

    // Straight from Linear to GitHub — no null in between.
    const github = { id: "github", name: "GitHub", authTypes: ["api_key" as const] }
    rerender(
      <ConnectorDetail
        {...props}
        provider={card(github)}
        detail={detail({
          ...github,
          oauthScopes: [],
          fields: [
            { name: "apiKey", label: "Personal access token", kind: "password", required: true }
          ]
        })}
      />
    )

    const field = screen.getByPlaceholderText("Personal access token") as HTMLInputElement
    expect(field.value).toBe("")
    // The connection alias resets too — "work" belonged to the other provider.
    expect((screen.getByPlaceholderText("default") as HTMLInputElement).value).toBe("default")
    expect(screen.queryByDisplayValue("lin_api_secret")).toBeNull()
  })

  /**
   * The generic `apiKey` fallback is editable while the detail loads — only the
   * Connect button is disabled, not the input. So a value typed into it can
   * outlive the field set it was typed into, and OpenConnector rejects unknown
   * credential keys outright (`additionalProperties: false`), which would turn a
   * correctly-filled form into an unexplained 400.
   */
  it("drops a value typed into the fallback field before the real fields arrive", async () => {
    const props = base()
    const postgres = { id: "postgres", name: "Postgres", authTypes: ["custom_credential" as const] }
    const { rerender } = render(
      <ConnectorDetail {...props} provider={card(postgres)} detail={null} detailLoading />
    )

    // Detail hasn't landed, so this is the generic fallback box.
    fireEvent.change(screen.getByPlaceholderText("API key"), { target: { value: "typed-too-early" } })

    // The real descriptors arrive and replace it with host + password.
    rerender(
      <ConnectorDetail
        {...props}
        provider={card(postgres)}
        detail={detail({
          ...postgres,
          oauthScopes: [],
          fields: [
            { name: "host", label: "Host", kind: "text", required: true, placeholder: "localhost" },
            { name: "password", label: "Password", kind: "password", required: true }
          ]
        })}
      />
    )
    fireEvent.change(screen.getByPlaceholderText("localhost"), { target: { value: "db.internal" } })
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "pw" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    await waitFor(() =>
      expect(props.onConnect).toHaveBeenCalledWith(
        "postgres",
        "custom_credential",
        // No stray `apiKey` — the instance would reject the whole request for it.
        { host: "db.internal", password: "pw" },
        undefined
      )
    )
  })

  /**
   * A `no_auth` provider is listed as connected because it needs no credential —
   * the instance calls it `virtual`. DELETE on one answers 200 with
   * `configured: true` and leaves it listed, so a Disconnect button here is the
   * worst kind of dead control: it looks destructive, the app reports success,
   * and the row is still there with no error to explain it.
   */
  it("offers no Disconnect for a connection with nothing stored to remove", () => {
    const props = base()
    render(
      <ConnectorDetail
        {...props}
        provider={card({ id: "hackernews", name: "Hacker News", authTypes: ["no_auth"] })}
        detail={detail({
          id: "hackernews",
          name: "Hacker News",
          authTypes: ["no_auth"],
          fields: [],
          oauthScopes: []
        })}
        connections={[
          {
            service: "hackernews",
            accountId: "hackernews:public",
            displayName: "Hacker News Public",
            grantedScopes: [],
            connectionName: null,
            removable: false,
            status: "connected"
          }
        ]}
      />
    )
    expect(screen.getByText("Hacker News Public")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull()
    expect(screen.getByText("built in")).toBeTruthy()
  })

  it("renders nothing when no provider is open", () => {
    render(<ConnectorDetail {...base()} provider={null} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
