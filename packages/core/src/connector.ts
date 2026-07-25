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

/** How a provider is connected. Mirrors OpenConnector's `authType` values. */
export const ConnectorAuthType = Schema.Literal("oauth2", "api_key", "custom_credential")
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

/** One provider in the catalog (`GET /v1/providers`). */
export const ConnectorProvider = Schema.Struct({
  /** The service slug OpenConnector knows it by, e.g. "github". */
  id: Schema.String,
  /** Display name, e.g. "GitHub". */
  name: Schema.String,
  /** Icon URL from the catalog, or null when none is supplied. */
  icon: Schema.NullOr(Schema.String),
  /** How this provider can be connected (may offer more than one). */
  authTypes: Schema.Array(ConnectorAuthType),
  /**
   * Fields the api-key / custom-credential form must collect. Empty when the
   * catalog does not declare them — the UI falls back to a single `apiKey` field.
   */
  fields: Schema.Array(ConnectorAuthField),
  /** Count of Actions the provider exposes, for the catalog row. Null if unknown. */
  actionCount: Schema.NullOr(Schema.Number)
})
export type ConnectorProvider = Schema.Schema.Type<typeof ConnectorProvider>

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
  connectionName: Schema.NullOr(Schema.String)
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
