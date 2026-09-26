import { Schema } from "effect"
import { AgentEndpoint } from "./agent-endpoint.js"
import {
  ProviderModelCapabilities,
  ProviderModelVerification
} from "./provider-catalog.js"
import { ProviderId, ProviderModelId } from "./provider-connection.js"

export const AgentEndpointModelStatus = Schema.Literal(
  "ready",
  "provider-disconnected",
  "unavailable"
)
export type AgentEndpointModelStatus = Schema.Schema.Type<typeof AgentEndpointModelStatus>

export const AgentEndpointModel = Schema.Struct({
  providerId: ProviderId,
  id: ProviderModelId,
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  capabilities: ProviderModelCapabilities,
  verification: ProviderModelVerification,
  status: AgentEndpointModelStatus,
  selectable: Schema.Boolean,
  certificationKey: Schema.NullOr(Schema.String)
})
export type AgentEndpointModel = Schema.Schema.Type<typeof AgentEndpointModel>

export const AgentEndpointCatalogEntry = Schema.Struct({
  endpoint: AgentEndpoint,
  models: Schema.Array(AgentEndpointModel).pipe(Schema.maxItems(256))
})
export type AgentEndpointCatalogEntry = Schema.Schema.Type<typeof AgentEndpointCatalogEntry>

export const AgentEndpointCatalog = Schema.Struct({
  endpoints: Schema.Array(AgentEndpointCatalogEntry).pipe(Schema.maxItems(64)),
  refreshedAt: Schema.String.pipe(Schema.maxLength(64)),
  stale: Schema.Boolean
})
export type AgentEndpointCatalog = Schema.Schema.Type<typeof AgentEndpointCatalog>
