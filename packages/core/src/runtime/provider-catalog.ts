import { Schema } from "effect"
import { ProviderConnection, ProviderId, ProviderModelId } from "./provider-connection.js"

export const ProviderModelCapabilities = Schema.Struct({
  contextWindow: Schema.NullOr(Schema.Number),
  reasoning: Schema.Array(Schema.String),
  vision: Schema.Boolean
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
