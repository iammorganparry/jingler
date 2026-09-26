import { Schema } from "effect"
import { ReasoningEffort } from "./reasoning-effort.js"
import { ProviderConnection, ProviderId, ProviderModelId } from "./provider-connection.js"

export const ProviderModelCapabilities = Schema.Struct({
  contextWindow: Schema.NullOr(Schema.Number),
  reasoning: Schema.Array(ReasoningEffort),
  /** Whether pi reports the explicit `off` thinking level for this model. */
  reasoningCanDisable: Schema.optional(Schema.Boolean),
  /** Pi's resolved default after clamping its `medium` default to this model. */
  reasoningDefault: Schema.optional(ReasoningEffort),
  vision: Schema.Boolean,
  /** Verified support for the provider's server-side web-search tool. */
  nativeWebSearch: Schema.optional(Schema.Boolean)
})
export type ProviderModelCapabilities = Schema.Schema.Type<typeof ProviderModelCapabilities>

export const ProviderModelVerification = Schema.Literal(
  "certified",
  "unverified",
  "stale",
  "target-unavailable",
  "connection-unavailable"
)
export type ProviderModelVerification = Schema.Schema.Type<typeof ProviderModelVerification>

export const ProviderCatalogModel = Schema.Struct({
  providerId: ProviderId,
  id: ProviderModelId,
  label: Schema.String,
  capabilities: ProviderModelCapabilities,
  verification: ProviderModelVerification,
  selectable: Schema.Boolean,
  certificationKey: Schema.NullOr(Schema.String)
})
export type ProviderCatalogModel = Schema.Schema.Type<typeof ProviderCatalogModel>

export const ProviderCatalogConnection = Schema.Struct({
  connection: ProviderConnection,
  models: Schema.Array(ProviderCatalogModel)
})
export type ProviderCatalogConnection = Schema.Schema.Type<typeof ProviderCatalogConnection>

export const ProviderCatalog = Schema.Struct({
  connections: Schema.Array(ProviderCatalogConnection),
  refreshedAt: Schema.String,
  stale: Schema.Boolean
})
export type ProviderCatalog = Schema.Schema.Type<typeof ProviderCatalog>
