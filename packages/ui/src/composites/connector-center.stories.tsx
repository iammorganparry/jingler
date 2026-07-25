import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ConnectorConnection, ConnectorProvider, OAuthClientInfo } from "@starbase/core"
import { ConnectorCenter } from "./connector-center.js"

/**
 * Fixtures mirror the live OpenConnector catalog: `icon` is null for every
 * provider (the instance never populates it) and the logo is derived from
 * `homepageUrl` instead — so Storybook shows the same favicon path the app does,
 * and the initial-letter fallback whenever the network is absent.
 */
const PROVIDERS: ReadonlyArray<ConnectorProvider> = [
  {
    id: "github",
    name: "GitHub",
    icon: null,
    categories: ["Developer Tools"],
    homepageUrl: "https://github.com/",
    authTypes: ["oauth2", "api_key"],
    actionCount: 42
  },
  {
    id: "slack",
    name: "Slack",
    icon: null,
    categories: ["Communication", "Productivity"],
    homepageUrl: "https://slack.com/",
    authTypes: ["oauth2"],
    actionCount: 18
  },
  {
    id: "postgres",
    name: "Postgres",
    icon: null,
    categories: ["Data"],
    homepageUrl: "https://www.postgresql.org",
    authTypes: ["custom_credential"],
    actionCount: 7
  },
  {
    id: "notion",
    name: "Notion",
    icon: null,
    categories: ["Productivity"],
    homepageUrl: "https://www.notion.so",
    authTypes: ["oauth2", "api_key"],
    actionCount: 12
  },
  {
    id: "linear",
    name: "Linear",
    icon: null,
    categories: ["Productivity", "Developer Tools"],
    homepageUrl: "https://linear.app",
    authTypes: ["oauth2", "api_key"],
    actionCount: 34
  },
  // No credential at all, and connected on arrival — the state the auth-type
  // union used to have no way to express.
  {
    id: "hackernews",
    name: "Hacker News",
    icon: null,
    categories: ["Data"],
    homepageUrl: "https://news.ycombinator.com",
    authTypes: ["no_auth"],
    actionCount: 4
  },
  // No homepage: the one provider that must fall back to an initial tile.
  {
    id: "internal_tool",
    name: "Internal Tool",
    icon: null,
    categories: ["Developer Tools"],
    homepageUrl: null,
    authTypes: ["api_key"],
    actionCount: 2
  }
]

const CONNECTIONS: ReadonlyArray<ConnectorConnection> = [
  {
    service: "github",
    accountId: "u_1",
    displayName: "octocat",
    grantedScopes: ["repo", "read:org"],
    connectionName: null,
    removable: true,
    status: "connected"
  },
  // Virtual: it needs no credential, so there is nothing stored to disconnect.
  // Its row shows a "built in" chip where the danger button would be.
  {
    service: "hackernews",
    accountId: "hackernews:public",
    displayName: "Hacker News Public",
    grantedScopes: [],
    connectionName: null,
    removable: false,
    status: "connected"
  }
]

const OAUTH: ReadonlyArray<OAuthClientInfo> = [
  {
    provider: "slack",
    expectedRedirectUri: "http://localhost:3000/oauth/callback",
    hasClient: false,
    clientFields: [
      { name: "clientId", label: "Client ID", kind: "text", required: true },
      { name: "clientSecret", label: "Client secret", kind: "password", required: true }
    ]
  }
]

const noop = async () => {}

const meta = {
  title: "Composites/ConnectorCenter",
  component: ConnectorCenter,
  args: {
    providers: PROVIDERS,
    connections: CONNECTIONS,
    oauthConfigs: OAUTH,
    loading: false,
    error: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    onOpenProvider: () => {},
    onConnect: noop,
    onDisconnect: noop,
    onSetOauthConfig: noop,
    onStartOauth: noop,
    onRefresh: () => {}
  },
  parameters: { layout: "padded" }
} satisfies Meta<typeof ConnectorCenter>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NotConfigured: Story = {
  args: {
    providers: [],
    connections: [],
    oauthConfigs: [],
    error: "OpenConnector is not configured — set an endpoint and token in Settings."
  }
}

export const Empty: Story = {
  args: { connections: [] }
}

// The detail sheet's own states are documented in `connector-detail.stories.tsx`.
// They cannot live here: the sheet mounts only when a card is open, and the open
// card is internal state no story arg can reach — so a `detailLoading: true`
// story here renders identically to Default.

/**
 * An OAuth grant begun but not consented. It is listed, so it would read as
 * connected if the grid counted rows rather than usable ones — the amber dot and
 * "Pending" exist to keep "started" and "working" apart.
 */
export const PendingConnection: Story = {
  args: {
    connections: [
      ...CONNECTIONS,
      {
        service: "slack",
        accountId: "",
        displayName: null,
        grantedScopes: [],
        connectionName: null,
        removable: true,
        status: "pending"
      }
    ]
  }
}
