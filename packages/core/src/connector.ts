import { Schema } from "effect"

/**
 * The MCP Connector Center domain: the provider catalog, connection state, and
 * OAuth-client metadata surfaced by a self-hosted OpenConnector instance.
 *
 * These types cross the RPC boundary, so — like `McpServer` — they are the
 * redaction contract: they describe HOW to connect (field NAMES, auth kinds,
 * scopes) and never carry a value. Api keys, client secrets, and OAuth tokens
 * travel renderer→main→OpenConnector on request PAYLOADS only; nothing here is a
 * home for one.
 */

/**
 * How a provider is connected. Mirrors OpenConnector's `authType` values.
 *
 * `no_auth` is not a placeholder — eight catalogued providers (arXiv, Hacker
 * News, Docsend2pdf…) take no credential at all and arrive from the instance
 * already `configured: true, virtual: true`. Leaving it out of this union is
 * indistinguishable from "unknown auth type", which the mapper defaults to
 * `api_key` — so those eight rendered a credential form for a credential that
 * does not exist.
 */
export const ConnectorAuthType = Schema.Literal(
  "oauth2",
  "api_key",
  "custom_credential",
  "no_auth"
)
export type ConnectorAuthType = Schema.Schema.Type<typeof ConnectorAuthType>

/**
 * One input a connect form must collect (an api-key field, or an OAuth client
 * id/secret field). NAME + presentation only — the value is entered in the UI and
 * sent on a request, never stored in this shape.
 */
export const ConnectorAuthField = Schema.Struct({
  /** The key the value is submitted under, e.g. "apiKey", "clientSecret", "host". */
  name: Schema.String,
  /** Human label for the field. */
  label: Schema.String,
  /** `password` fields are rendered write-only and masked. */
  kind: Schema.Literal("text", "password"),
  required: Schema.Boolean,
  /** Optional placeholder / example, safe to display (never a real secret). */
  placeholder: Schema.optional(Schema.String)
})
export type ConnectorAuthField = Schema.Schema.Type<typeof ConnectorAuthField>

/**
 * One provider in the catalog (`GET /v1/providers`) — the LIST shape, ~1,100 of
 * them, and the only thing the grid needs.
 *
 * It deliberately carries no auth `fields`: the list endpoint does not send
 * them, and the endpoint that does (`GET /api/providers`) inlines every action's
 * JSON Schema for every provider and weighs 5 MB. Fields live on
 * `ConnectorProviderDetail`, fetched one provider at a time.
 */
export const ConnectorProvider = Schema.Struct({
  /** The service slug OpenConnector knows it by, e.g. "github". */
  id: Schema.String,
  /** Display name, e.g. "GitHub". */
  name: Schema.String,
  /**
   * Icon URL from the catalog. The live instance returns null for every
   * provider, so the UI derives a logo from `homepageUrl` instead — but a
   * self-hosted catalog may populate it, and then it wins.
   */
  icon: Schema.NullOr(Schema.String),
  /** Category ids, e.g. ["Productivity", "Developer Tools"]. Drives the filter. */
  categories: Schema.Array(Schema.String),
  /** The provider's own site — the logo source, and the "Homepage" link. */
  homepageUrl: Schema.NullOr(Schema.String),
  /** How this provider can be connected (may offer more than one). */
  authTypes: Schema.Array(ConnectorAuthType),
  /** Count of Actions the provider exposes, for the catalog row. Null if unknown. */
  actionCount: Schema.NullOr(Schema.Number)
})
export type ConnectorProvider = Schema.Schema.Type<typeof ConnectorProvider>

/**
 * One provider's detail (`GET /api/providers/{service}`), fetched only when its
 * card is opened. This is where the connect form gets its REAL shape — Linear's
 * `lin_api_…` placeholder, Notion's "Internal Integration Secret" label, a
 * custom-credential provider's host+password pair — instead of the single
 * generic `apiKey` box every provider used to fall back to.
 *
 * Same redaction contract as the rest of this file: it describes how to
 * connect, never a value.
 */
export const ConnectorProviderDetail = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  categories: Schema.Array(Schema.String),
  homepageUrl: Schema.NullOr(Schema.String),
  authTypes: Schema.Array(ConnectorAuthType),
  /** Fields the api-key / custom-credential form must collect. */
  fields: Schema.Array(ConnectorAuthField),
  /** Scopes the OAuth grant will request, for the "Scopes" readout. */
  oauthScopes: Schema.Array(Schema.String),
  /** How many Actions the provider exposes. Null if the catalog omits them. */
  actionCount: Schema.NullOr(Schema.Number),
  /** Prose from the catalog's auth descriptor (where to create the key), or null. */
  description: Schema.NullOr(Schema.String)
})
export type ConnectorProviderDetail = Schema.Schema.Type<typeof ConnectorProviderDetail>

/** An established connection (`GET /api/connections`). Carries no credential. */
export const ConnectorConnection = Schema.Struct({
  /** Matches `ConnectorProvider.id`. */
  service: Schema.String,
  /** OpenConnector's id for the connected account. */
  accountId: Schema.String,
  /** A human label for the account (e.g. the login), or null. */
  displayName: Schema.NullOr(Schema.String),
  /** Scopes the grant covers (OAuth); empty for api-key connections. */
  grantedScopes: Schema.Array(Schema.String),
  /** The named-connection alias, or null for the default connection. */
  connectionName: Schema.NullOr(Schema.String),
  /**
   * Whether there is a stored credential to remove.
   *
   * False for what the instance calls a `virtual` connection: a `no_auth`
   * provider is listed as connected because it needs no credential, so there is
   * nothing to delete. `DELETE` on one answers 200 with `configured: true` and
   * leaves it in place — a success the app would otherwise report while the row
   * stayed put, so the UI hides the Disconnect affordance instead.
   */
  removable: Schema.Boolean,
  /**
   * Whether the credential is actually usable yet. A `no_auth` provider is
   * `connected` the moment it is catalogued; an OAuth grant that has been
   * started but not consented is `pending`. The grid's status dot reads this,
   * so "listed" and "working" stay distinguishable.
   */
  status: Schema.Literal("connected", "pending")
})
export type ConnectorConnection = Schema.Schema.Type<typeof ConnectorConnection>

/**
 * OAuth-client metadata for a provider (`GET /api/oauth/configs`). `hasClient`
 * says whether client credentials are already stored — the actual id/secret are
 * never returned, only whether they exist.
 */
export const OAuthClientInfo = Schema.Struct({
  provider: Schema.String,
  /** The exact callback URL the operator must register in the OAuth app. */
  expectedRedirectUri: Schema.String,
  /** True when client id/secret are already stored (so the UI can skip the form). */
  hasClient: Schema.Boolean,
  /** The client-config fields to collect (clientId/clientSecret, plus any extras). */
  clientFields: Schema.Array(ConnectorAuthField)
})
export type OAuthClientInfo = Schema.Schema.Type<typeof OAuthClientInfo>

/** Outcome of a connect / disconnect / config write. Never carries a secret. */
export const ConnectorActionResult = Schema.Struct({
  ok: Schema.Boolean,
  /** A message for the UI (error detail or confirmation), or null. */
  message: Schema.NullOr(Schema.String)
})
export type ConnectorActionResult = Schema.Schema.Type<typeof ConnectorActionResult>
