import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ConnectorConnection, ConnectorProvider, OAuthClientInfo } from "@starbase/core"
import { ConnectorCenter } from "./connector-center.js"

const PROVIDERS: ReadonlyArray<ConnectorProvider> = [
  {
    id: "github",
    name: "GitHub",
    icon: null,
    authTypes: ["oauth2", "api_key"],
    fields: [{ name: "apiKey", label: "Personal access token", kind: "password", required: true }],
    actionCount: 42
  },
  { id: "slack", name: "Slack", icon: null, authTypes: ["oauth2"], fields: [], actionCount: 18 },
  {
    id: "postgres",
    name: "Postgres",
    icon: null,
    authTypes: ["custom_credential"],
    fields: [
      { name: "host", label: "Host", kind: "text", required: true, placeholder: "localhost" },
      { name: "password", label: "Password", kind: "password", required: true }
    ],
    actionCount: 7
  },
  { id: "notion", name: "Notion", icon: null, authTypes: ["oauth2"], fields: [], actionCount: 12 }
]

const CONNECTIONS: ReadonlyArray<ConnectorConnection> = [
  { service: "github", accountId: "u_1", displayName: "octocat", grantedScopes: ["repo", "read:org"], connectionName: null }
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
