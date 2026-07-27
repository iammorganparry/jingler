import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail
} from "@jingler/core"
import { ConnectorDetail } from "./connector-detail.js"

/**
 * The provider detail sheet — where connecting actually happens.
 *
 * It gets its own stories because it cannot be reached from the
 * `ConnectorCenter` ones: the sheet mounts only when a card is open, and that is
 * internal state no story arg can set. Rendered directly, every state below is
 * one arg away.
 *
 * The fixtures are real catalog shapes, not invented ones — Linear offers OAuth
 * and a key, Elasticsearch offers two ALTERNATIVE key forms, Hacker News takes
 * no credential at all.
 */

const card = (over: Partial<ConnectorProvider>): ConnectorProvider => ({
  id: "linear",
  name: "Linear",
  icon: null,
  categories: ["Productivity"],
  homepageUrl: "https://linear.app",
  authTypes: ["oauth2", "api_key"],
  actionCount: 34,
  ...over
})

const LINEAR = card({})

const LINEAR_DETAIL: ConnectorProviderDetail = {
  id: "linear",
  name: "Linear",
  categories: ["Productivity"],
  homepageUrl: "https://linear.app",
  authTypes: ["oauth2", "api_key"],
  keyModes: [
    {
      type: "api_key",
      label: "Personal API Key",
      description: "Create or revoke it from Settings › Account › Security & Access.",
      fields: [
        {
          name: "apiKey",
          label: "Personal API Key",
          kind: "password",
          required: true,
          placeholder: "lin_api_..."
        }
      ]
    }
  ],
  oauthScopes: ["read", "write", "issues:create", "comments:create"],
  actionCount: 34
}

const noop = async () => {}

const meta = {
  title: "Composites/ConnectorDetail",
  component: ConnectorDetail,
  args: {
    provider: LINEAR,
    detail: LINEAR_DETAIL,
    detailLoading: false,
    detailError: null,
    connections: [] as ReadonlyArray<ConnectorConnection>,
    oauthInfo: undefined,
    onClose: () => {},
    onConnect: noop,
    onDisconnect: noop,
    onSetOauthConfig: noop,
    onStartOauth: noop
  },
  parameters: { layout: "centered" }
} satisfies Meta<typeof ConnectorDetail>

export default meta
type Story = StoryObj<typeof meta>

/** A provider offering both OAuth and a key. OAuth leads; the key is one tab away. */
export const Default: Story = {}

/**
 * Mid-fetch. The header's auth chips come from the catalog LIST entry, so the
 * sheet shows the right shape immediately rather than flashing a generic form
 * and swapping it — but the fields are the fallback until the real ones land.
 */
export const Loading: Story = {
  args: { detail: null, detailLoading: true }
}

/** The per-provider fetch failed. The form still works from the list entry's types. */
export const DetailFailed: Story = {
  args: {
    detail: null,
    detailError: "Couldn't reach the OpenConnector instance."
  }
}

/**
 * Two ALTERNATIVE credential forms — Elasticsearch's real shape. Each is a tab
 * submitting under its own `authType`; merged into one form the provider could
 * not be connected at all, because the instance rejects a field the chosen type
 * never declared.
 */
export const TwoCredentialModes: Story = {
  args: {
    provider: card({
      id: "elasticsearch",
      name: "Elasticsearch",
      homepageUrl: "https://www.elastic.co",
      authTypes: ["api_key", "custom_credential"]
    }),
    detail: {
      id: "elasticsearch",
      name: "Elasticsearch",
      categories: ["Data"],
      homepageUrl: "https://www.elastic.co",
      authTypes: ["api_key", "custom_credential"],
      oauthScopes: [],
      actionCount: 12,
      keyModes: [
        {
          type: "api_key",
          label: "Encoded API Key",
          description: null,
          fields: [
            {
              name: "apiKey",
              label: "Encoded API Key",
              kind: "password",
              required: true,
              placeholder: "base64-encoded-id-and-api-key"
            },
            { name: "baseUrl", label: "Elasticsearch URL", kind: "text", required: true }
          ]
        },
        {
          type: "custom_credential",
          label: null,
          description: null,
          fields: [
            { name: "baseUrl", label: "Elasticsearch URL", kind: "text", required: true },
            { name: "username", label: "Username", kind: "text", required: true },
            { name: "password", label: "Password", kind: "password", required: true }
          ]
        }
      ]
    }
  }
}

/** No credential to collect, and nothing stored to disconnect. */
export const NoAuthNeeded: Story = {
  args: {
    provider: card({
      id: "hackernews",
      name: "Hacker News",
      homepageUrl: "https://news.ycombinator.com",
      authTypes: ["no_auth"]
    }),
    detail: {
      id: "hackernews",
      name: "Hacker News",
      categories: ["Data"],
      homepageUrl: "https://news.ycombinator.com",
      authTypes: ["no_auth"],
      keyModes: [],
      oauthScopes: [],
      actionCount: 4
    },
    connections: [
      {
        service: "hackernews",
        accountId: "hackernews:public",
        displayName: "Hacker News Public",
        grantedScopes: [],
        connectionName: null,
        // Virtual: the "built in" chip stands where Disconnect would, because
        // DELETE on one answers 200 and leaves it in place.
        removable: false,
        status: "connected"
      }
    ]
  }
}

/**
 * Already connected. The name field starts BLANK here — reusing "default" would
 * replace the credential above rather than add a second account.
 */
export const AddingASecondAccount: Story = {
  args: {
    connections: [
      {
        service: "linear",
        accountId: "acct_1",
        displayName: "Acme Engineering",
        grantedScopes: ["read", "write"],
        connectionName: null,
        removable: true,
        status: "connected"
      }
    ]
  }
}

/** An OAuth grant begun but not consented — listed, but it cannot run an action yet. */
export const PendingGrant: Story = {
  args: {
    connections: [
      {
        service: "linear",
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

/** OAuth needs a local client first — the redirect URI to register is shown. */
export const NeedsOauthClient: Story = {
  args: {
    oauthInfo: {
      provider: "linear",
      expectedRedirectUri: "http://localhost:3000/oauth/callback",
      hasClient: false,
      clientFields: [
        { name: "clientId", label: "Client ID", kind: "text", required: true },
        { name: "clientSecret", label: "Client secret", kind: "password", required: true }
      ]
    }
  }
}

/**
 * Slack's real fifteen scopes. Uncapped this list pushed the Close button off
 * the bottom of the sheet, so it collapses to five behind a `+10 more` toggle.
 */
export const ManyScopes: Story = {
  args: {
    provider: card({
      id: "slack",
      name: "Slack",
      homepageUrl: "https://slack.com/",
      authTypes: ["oauth2"]
    }),
    detail: {
      id: "slack",
      name: "Slack",
      categories: ["Communication"],
      homepageUrl: "https://slack.com/",
      authTypes: ["oauth2"],
      keyModes: [],
      actionCount: 22,
      oauthScopes: [
        "channels:read",
        "groups:read",
        "im:read",
        "mpim:read",
        "users:read",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "files:read",
        "reactions:read",
        "chat:write",
        "im:write",
        "files:write",
        "reactions:write"
      ]
    }
  }
}
